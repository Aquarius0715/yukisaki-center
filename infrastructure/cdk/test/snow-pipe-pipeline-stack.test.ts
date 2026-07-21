import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { SnowPipePipelineStack } from '../lib/snow-pipe-pipeline-stack';

describe('SnowPipePipelineStack', () => {
  const app = new App();
  const stack = new SnowPipePipelineStack(app, 'SnowPipeTestStack', {
    environment: 'test', targetReferenceTime: '2026-01-23T12:00:00+09:00',
    roadBucketName: 'road-bucket',
  });
  const template = Template.fromStack(stack);

  test('creates three Lambda images, a Standard workflow, and two-stage DLQs', () => {
    template.resourcePropertiesCountIs('AWS::Lambda::Function', { PackageType: 'Image' }, 3);
    template.hasResourceProperties('AWS::StepFunctions::StateMachine', { StateMachineType: 'STANDARD' });
    template.resourceCountIs('AWS::SQS::Queue', 3);
    template.resourceCountIs('AWS::RDS::DBInstance', 1);
    template.resourceCountIs('AWS::S3::Bucket', 2);
    template.hasResourceProperties('AWS::S3::Bucket', {
      VersioningConfiguration: { Status: 'Enabled' },
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
    template.hasResourceProperties('AWS::RDS::DBInstance', { DBName: 'yukisaki_map' });
  });

  test('starts only for CloudTrail road manifest write events', () => {
    template.resourceCountIs('AWS::CloudTrail::Trail', 1);
    template.hasResourceProperties('AWS::Events::Rule', {
      State: 'ENABLED',
      EventPattern: Match.objectLike({
        source: ['aws.s3'],
        'detail-type': ['AWS API Call via CloudTrail'],
        detail: {
          eventSource: ['s3.amazonaws.com'],
          eventName: ['PutObject', 'CompleteMultipartUpload', 'CopyObject'],
          requestParameters: {
            bucketName: [Match.anyValue()],
            key: [{ prefix: 'manifests/data-ingestion/' }],
          },
        },
      }),
    });
  });

  test('places only the loader in the database VPC', () => {
    const functions = template.findResources('AWS::Lambda::Function');
    const vpcFunctions = Object.values(functions).filter((resource) => resource.Properties.VpcConfig);
    expect(vpcFunctions).toHaveLength(1);
    expect(JSON.stringify(vpcFunctions[0].Properties.ImageConfig)).toContain('loader_handler');
    expect(vpcFunctions[0].Properties.ReservedConcurrentExecutions).toBe(0);
  });
});
