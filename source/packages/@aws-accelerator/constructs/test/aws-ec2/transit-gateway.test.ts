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

import * as cdk from 'aws-cdk-lib';
import { SynthUtils } from '@aws-cdk/assert';
import { TransitGatewayRouteTableAssociation } from '../../lib/aws-ec2/transit-gateway';

const testNamePrefix = 'Construct(TransitGatewayRouteTableAssociation): ';

//Initialize stack for snapshot test and resource configuration test
const stack = new cdk.Stack();

new TransitGatewayRouteTableAssociation(stack, 'TransitGatewayRouteTableAssociation', {
  transitGatewayAttachmentId: 'transitGatewayAttachmentId',
  transitGatewayRouteTableId: 'transitGatewayRouteTableId',
});
/**
 * TransitGatewayRouteTableAssociation construct test
 */
describe('TransitGatewayRouteTableAssociation', () => {
  /**
   * Snapshot test
   */
  test(`${testNamePrefix} Snapshot Test`, () => {
    expect(SynthUtils.toCloudFormation(stack)).toMatchSnapshot();
  });
  /**
   * Number of TransitGatewayRouteTableAssociation resource test
   */
  test(`${testNamePrefix} TransitGatewayRouteTableAssociation resource count test`, () => {
    cdk.assertions.Template.fromStack(stack).resourceCountIs('AWS::EC2::TransitGatewayRouteTableAssociation', 1);
  });

  /**
   * TransitGatewayRouteTableAssociation resource configuration test
   */
  test(`${testNamePrefix} TransitGatewayRouteTableAssociation resource configuration test`, () => {
    cdk.assertions.Template.fromStack(stack).templateMatches({
      Resources: {
        TransitGatewayRouteTableAssociation19E386E4: {
          Type: 'AWS::EC2::TransitGatewayRouteTableAssociation',
          Properties: {
            TransitGatewayAttachmentId: 'transitGatewayAttachmentId',
            TransitGatewayRouteTableId: 'transitGatewayRouteTableId',
          },
        },
      },
    });
  });
});
