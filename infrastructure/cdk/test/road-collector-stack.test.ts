import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { RoadCollectorStack } from '../lib/road-collector-stack';

describe('RoadCollectorStack', () => {
  const stack = new RoadCollectorStack(new App(), 'RoadTestStack', {
    environment: 'test',
    scheduleEnabled: false,
    scheduleHours: 168,
  });
  const template = Template.fromStack(stack);

  test('creates an isolated private road bucket and Fargate task', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      VersioningConfiguration: { Status: 'Enabled' },
    });
    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      RequiresCompatibilities: ['FARGATE'],
      Cpu: '2048',
      Memory: '8192',
      ContainerDefinitions: Match.arrayWith([
        Match.objectLike({
          Environment: Match.arrayWith([
            { Name: 'OSM_PLACE_NAME', Value: '新潟県長岡市' },
          ]),
        }),
      ]),
    });
    template.hasResourceProperties('AWS::Events::Rule', {
      ScheduleExpression: 'rate(7 days)',
      State: 'DISABLED',
    });
    template.resourceCountIs('AWS::SQS::Queue', 1);
  });
});
