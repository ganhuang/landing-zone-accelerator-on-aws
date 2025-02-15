/**
 *  Copyright 2022 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 *
 *  Licensed under the Apache License, Version 2.0 (the "License"). You may not use this file except in compliance
 *  with the License. A copy of the License is located at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 *  or in the 'license' file accompanying this file. This file is distributed on an 'AS IS' BASIS, WITHOUT WARRANTIES
 *  OR CONDITIONS OF ANY KIND, express or implied. See the License for the specific language governing permissions
 *  and limitations under the License.
 */

import { throttlingBackOff } from '@aws-accelerator/utils';
import * as AWS from 'aws-sdk';
AWS.config.logger = console;

/**
 * batch-enable-standards - lambda handler
 *
 * @param event
 * @returns
 */
export async function handler(event: AWSLambda.CloudFormationCustomResourceEvent): Promise<
  | {
      Status: string | undefined;
      StatusCode: number | undefined;
    }
  | undefined
> {
  const region = event.ResourceProperties['region'];
  const inputStandards: { name: string; enable: boolean; controlsToDisable: string[] | undefined }[] =
    event.ResourceProperties['standards'];

  const securityHubClient = new AWS.SecurityHub({ region: region });

  // Get AWS defined security standards name and ARN
  const awsSecurityHubStandards: { [name: string]: string }[] = [];
  let nextToken: string | undefined = undefined;
  do {
    const page = await throttlingBackOff(() => securityHubClient.describeStandards({ NextToken: nextToken }).promise());
    for (const standard of page.Standards ?? []) {
      if (standard.StandardsArn && standard.Name) {
        const securityHubStandard: { [name: string]: string } = {};
        securityHubStandard[standard.Name] = standard.StandardsArn;
        awsSecurityHubStandards.push(securityHubStandard);
      }
    }
    nextToken = page.NextToken;
  } while (nextToken);

  // Enable security hub is admin account before creating delegation admin account, if this wasn't enabled by organization delegation
  await enableSecurityHub(securityHubClient);

  const standardsModificationList = await getStandardsModificationList(
    securityHubClient,
    inputStandards,
    awsSecurityHubStandards,
  );
  console.log('standardsModificationList');
  console.log(standardsModificationList);

  switch (event.RequestType) {
    case 'Create':
    case 'Update':
      console.log('starting - BatchEnableStandardsCommand');

      // When there are standards to be enable
      if (standardsModificationList.toEnableStandardRequests.length > 0) {
        console.log('to enable');
        console.log(standardsModificationList.toEnableStandardRequests);
        await throttlingBackOff(() =>
          securityHubClient
            .batchEnableStandards({
              StandardsSubscriptionRequests: standardsModificationList.toEnableStandardRequests,
            })
            .promise(),
        );
      }

      // When there are standards to be disable
      if (standardsModificationList.toDisableStandardArns!.length > 0) {
        console.log('to disable');
        console.log(standardsModificationList.toEnableStandardRequests);
        await throttlingBackOff(() =>
          securityHubClient
            .batchDisableStandards({
              StandardsSubscriptionArns: standardsModificationList.toDisableStandardArns!,
            })
            .promise(),
        );
      }

      // get list of controls to modify
      const controlsToModify = await getControlArnsToModify(securityHubClient, inputStandards, awsSecurityHubStandards);

      // Enable standard controls
      for (const controlArnToModify of controlsToModify.disableStandardControlArns) {
        await throttlingBackOff(() =>
          securityHubClient
            .updateStandardsControl({
              StandardsControlArn: controlArnToModify,
              ControlStatus: 'DISABLED',
              DisabledReason: 'Control disabled by Accelerator',
            })
            .promise(),
        );
      }

      // Disable standard controls
      for (const controlArnToModify of controlsToModify.enableStandardControlArns) {
        await throttlingBackOff(() =>
          securityHubClient
            .updateStandardsControl({ StandardsControlArn: controlArnToModify, ControlStatus: 'ENABLED' })
            .promise(),
        );
      }

      return { Status: 'Success', StatusCode: 200 };

    case 'Delete':
      const existingEnabledStandards = await getExistingEnabledStandards(securityHubClient);
      const subscriptionArns: string[] = [];
      existingEnabledStandards.forEach(standard => {
        subscriptionArns.push(standard.StandardsSubscriptionArn);
      });

      if (subscriptionArns.length > 0) {
        console.log('Below listed standards disable during delete');
        console.log(subscriptionArns);
        await throttlingBackOff(() =>
          securityHubClient.batchDisableStandards({ StandardsSubscriptionArns: subscriptionArns }).promise(),
        );
      }

      return { Status: 'Success', StatusCode: 200 };
  }
}

/**
 * Enable SecurityHub
 * @param securityHubClient
 */
async function enableSecurityHub(securityHubClient: AWS.SecurityHub): Promise<void> {
  try {
    await throttlingBackOff(() => securityHubClient.enableSecurityHub({ EnableDefaultStandards: false }).promise());
  } catch (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    e: any
  ) {
    if (
      // SDKv2 Error Structure
      e.code === 'ResourceConflictException' ||
      // SDKv3 Error Structure
      e.name === 'ResourceConflictException'
    ) {
      console.warn(e.name + ': ' + e.message);
      return;
    }
    throw new Error(`SecurityHub enable issue error message - ${e}`);
  }
}

/**
 * Function to provide existing enabled standards
 * @param securityHubClient
 */
async function getExistingEnabledStandards(
  securityHubClient: AWS.SecurityHub,
): Promise<AWS.SecurityHub.StandardsSubscription[]> {
  const response = await throttlingBackOff(() => securityHubClient.getEnabledStandards({}).promise());

  // Get list of  existing enabled standards within securityhub
  const existingEnabledStandardArns: AWS.SecurityHub.StandardsSubscription[] = [];
  response.StandardsSubscriptions!.forEach(item => {
    // if (item.StandardsStatus === StandardsStatus.READY) {
    existingEnabledStandardArns.push({
      StandardsArn: item.StandardsArn!,
      StandardsInput: item.StandardsInput!,
      StandardsStatus: item.StandardsStatus!,
      StandardsSubscriptionArn: item.StandardsSubscriptionArn!,
    });
    // }
  });

  return existingEnabledStandardArns;
}

/**
 * Function to provide list of control arns for standards to be enable or disable
 * @param securityHubClient
 * @param inputStandards
 * @param awsSecurityHubStandards
 */
async function getControlArnsToModify(
  securityHubClient: AWS.SecurityHub,
  inputStandards: { name: string; enable: boolean; controlsToDisable: string[] | undefined }[],
  awsSecurityHubStandards: { [name: string]: string }[],
): Promise<{ disableStandardControlArns: string[]; enableStandardControlArns: string[] }> {
  const existingEnabledStandards = await getExistingEnabledStandards(securityHubClient);
  const disableStandardControls: string[] = [];
  const enableStandardControls: string[] = [];

  for (const inputStandard of inputStandards) {
    if (inputStandard.enable) {
      for (const awsSecurityHubStandard of awsSecurityHubStandards) {
        if (awsSecurityHubStandard[inputStandard.name]) {
          const existingEnabledStandard = existingEnabledStandards.find(
            item => item.StandardsArn === awsSecurityHubStandard[inputStandard.name],
          );
          if (existingEnabledStandard) {
            console.log(`Getting controls for ${existingEnabledStandard?.StandardsSubscriptionArn} subscription`);

            const standardsControl: AWS.SecurityHub.StandardsControl[] = [];

            let nextToken: string | undefined = undefined;
            do {
              const page = await throttlingBackOff(() =>
                securityHubClient
                  .describeStandardsControls({
                    StandardsSubscriptionArn: existingEnabledStandard?.StandardsSubscriptionArn,
                    NextToken: nextToken,
                  })
                  .promise(),
              );
              for (const control of page.Controls ?? []) {
                standardsControl.push(control);
              }
              nextToken = page.NextToken;
            } while (nextToken);

            while (standardsControl.length === 0) {
              console.warn(
                `Delaying standard control retrieval by 10000 ms for ${existingEnabledStandard?.StandardsSubscriptionArn}`,
              );
              await delay(10000);
              console.warn(`Rechecking - Getting controls for ${existingEnabledStandard?.StandardsSubscriptionArn}`);
              let nextToken: string | undefined = undefined;
              do {
                const page = await throttlingBackOff(() =>
                  securityHubClient
                    .describeStandardsControls({
                      StandardsSubscriptionArn: existingEnabledStandard?.StandardsSubscriptionArn,
                      NextToken: nextToken,
                    })
                    .promise(),
                );
                for (const control of page.Controls ?? []) {
                  standardsControl.push(control);
                }
                nextToken = page.NextToken;
              } while (nextToken);
            }

            console.log(`When control list available for ${existingEnabledStandard?.StandardsSubscriptionArn}`);
            console.log(standardsControl);

            for (const control of standardsControl) {
              if (inputStandard.controlsToDisable?.includes(control.ControlId!)) {
                console.log(control.ControlId!);
                console.log(inputStandard.name);
                disableStandardControls.push(control.StandardsControlArn!);
              } else {
                if (control.ControlStatus == 'DISABLED') {
                  console.log('following is disabled need to be enable now');
                  console.log(control.ControlId!);
                  enableStandardControls.push(control.StandardsControlArn!);
                }
              }
            }
          }
        }
      }
    }
  }
  console.log('***********');
  console.log(disableStandardControls);
  console.log(enableStandardControls);
  console.log('***********');

  return { disableStandardControlArns: disableStandardControls, enableStandardControlArns: enableStandardControls };
}

/**
 * Function to be executed before event specific action starts, this function makes the list of standards to be enable or disable based on the input
 * @param securityHubClient
 * @param inputStandards
 * @param awsSecurityHubStandards
 */
async function getStandardsModificationList(
  securityHubClient: AWS.SecurityHub,
  inputStandards: { name: string; enable: boolean; controlsToDisable: string[] | undefined }[],
  awsSecurityHubStandards: { [name: string]: string }[],
): Promise<{
  toEnableStandardRequests: AWS.SecurityHub.StandardsSubscriptionRequests;
  toDisableStandardArns: string[] | undefined;
}> {
  const existingEnabledStandards = await getExistingEnabledStandards(securityHubClient);
  const toEnableStandardRequests: AWS.SecurityHub.StandardsSubscriptionRequests = [];
  const toDisableStandardArns: string[] | undefined = [];

  for (const inputStandard of inputStandards) {
    if (inputStandard.enable) {
      for (const awsSecurityHubStandard of awsSecurityHubStandards) {
        if (awsSecurityHubStandard[inputStandard.name]) {
          const existingEnabledStandard = existingEnabledStandards.filter(
            item => item.StandardsArn === awsSecurityHubStandard[inputStandard.name],
          );
          if (existingEnabledStandard.length === 0) {
            toEnableStandardRequests.push({ StandardsArn: awsSecurityHubStandard[inputStandard.name] });
          }
        }
      }
    } else {
      for (const awsSecurityHubStandard of awsSecurityHubStandards) {
        if (awsSecurityHubStandard[inputStandard.name]) {
          const existingEnabledStandard = existingEnabledStandards.find(
            item => item.StandardsArn === awsSecurityHubStandard[inputStandard.name],
          );

          if (existingEnabledStandard) {
            toDisableStandardArns.push(existingEnabledStandard?.StandardsSubscriptionArn);
          }
        }
      }
    }
  }

  return { toEnableStandardRequests: toEnableStandardRequests, toDisableStandardArns: toDisableStandardArns };
}

async function delay(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
