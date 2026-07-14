import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { RoadCollectorStack } from '../lib/road-collector-stack';

describe('RoadCollectorStack', () => {
  const stack = new RoadCollectorStack(new App(), 'RoadTestStack', {
    environment: 'test',
    scheduleHours: 168,
  });
  const template = Template.fromStack(stack);

  test('creates an isolated private road bucket and Fargate task', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      VersioningConfiguration: { Status: 'Enabled' },
    });
    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      RequiresCompatibilities: ['FARGATE'],
      Cpu: '1024',
      Memory: '4096',
    });
    template.hasResourceProperties('AWS::Events::Rule', {
      ScheduleExpression: 'rate(168 hours)',
    });
  });
});
