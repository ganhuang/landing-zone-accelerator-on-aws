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

import { CredentialProviderSource } from 'aws-cdk/lib/api/aws-auth/credentials';
import * as AWS from 'aws-sdk';
import { green } from 'colors/safe';
import { throttlingBackOff } from './backoff';

export interface AssumeRoleProviderSourceProps {
  name: string;
  assumeRoleName: string;
  assumeRoleDuration: number;
  credentials?: AWS.STS.Credentials;
  partition?: string;
}

export class AssumeRoleProviderSource implements CredentialProviderSource {
  readonly name = this.props.name;
  private readonly cache: { [accountId: string]: AWS.Credentials } = {};

  constructor(private readonly props: AssumeRoleProviderSourceProps) {}

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async canProvideCredentials(): Promise<boolean> {
    return true;
  }

  async getProvider(accountId: string): Promise<AWS.Credentials> {
    if (this.cache[accountId]) {
      return this.cache[accountId];
    }

    let assumeRole;
    try {
      // Try to assume the role with the given duration
      assumeRole = await this.assumeRole(accountId, this.props.assumeRoleDuration);
    } catch (e) {
      console.warn(`Cannot assume role for ${this.props.assumeRoleDuration} seconds: ${e}`);

      // If that fails, than try to assume the role for one hour
      assumeRole = await this.assumeRole(accountId, 3600);
    }

    const credentials = assumeRole.Credentials!;
    return (this.cache[accountId] = new AWS.Credentials({
      accessKeyId: credentials.AccessKeyId,
      secretAccessKey: credentials.SecretAccessKey,
      sessionToken: credentials.SessionToken,
    }));
  }

  protected async assumeRole(accountId: string, duration: number): Promise<AWS.STS.AssumeRoleResponse> {
    const roleArn = `arn:${this.props.partition ?? 'aws'}:iam::${accountId}:role/${this.props.assumeRoleName}`;
    console.log(`Assuming role ${green(roleArn)} for ${duration} seconds`);

    let sts: AWS.STS;
    if (this.props.credentials) {
      sts = new AWS.STS({
        accessKeyId: this.props.credentials.AccessKeyId,
        secretAccessKey: this.props.credentials.SecretAccessKey,
        sessionToken: this.props.credentials.SessionToken,
      });
    } else {
      sts = new AWS.STS();
    }

    return throttlingBackOff(() =>
      sts
        .assumeRole({
          RoleArn: roleArn,
          RoleSessionName: this.name,
          DurationSeconds: duration,
        })
        .promise(),
    );
  }
}
