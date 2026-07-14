import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { DataPipelineStack } from '../lib/data-pipeline-stack';

describe('DataPipelineStack', () => {
  const app = new App();
  const stack = new DataPipelineStack(app, 'TestStack', {
    environment: 'test',
    scheduleMinutes: 60,
    weatherSourceUrl: 'https://www.data.jma.go.jp/developer/xml/feed/regular.xml',
  });
  const template = Template.fromStack(stack);

  test('creates a private versioned data bucket', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      VersioningConfiguration: { Status: 'Enabled' },
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
  });

  test('creates collector and normalizer functions', () => {
    template.resourcePropertiesCountIs(
      'AWS::Lambda::Function',
      { PackageType: 'Image' },
      2,
    );
    template.hasResourceProperties('AWS::Lambda::Function', {
      PackageType: 'Image',
      Architectures: ['arm64'],
    });
  });

  test('schedules collection and configures dead-letter queues', () => {
    template.hasResourceProperties('AWS::Scheduler::Schedule', {
      ScheduleExpression: 'rate(1 hour)',
      FlexibleTimeWindow: { Mode: 'OFF' },
      Target: Match.objectLike({
        RetryPolicy: {
          MaximumEventAgeInSeconds: 900,
          MaximumRetryAttempts: 2,
        },
      }),
    });
    template.resourceCountIs('AWS::SQS::Queue', 2);
  });

  test('rejects insecure source URLs', () => {
    expect(
      () =>
        new DataPipelineStack(new App(), 'InvalidStack', {
          environment: 'test',
          scheduleMinutes: 60,
          weatherSourceUrl: 'http://example.com/feed.xml',
        }),
    ).toThrow('weatherSourceUrl must use HTTPS');
  });
});
