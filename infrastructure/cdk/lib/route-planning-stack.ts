import * as path from 'path';
import {
  CfnOutput,
  Duration,
  RemovalPolicy,
  Stack,
  StackProps,
  Tags,
} from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecrAssets from 'aws-cdk-lib/aws-ecr-assets';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

export interface RoutePlanningStackProps extends StackProps {
  readonly environment: string;
  readonly databaseVpc: ec2.IVpc;
  readonly database: rds.IDatabaseInstance;
  readonly databaseSecret: secretsmanager.ISecret;
  readonly databaseName: string;
  readonly targetReferenceTime: string;
}

/** Private pgRouting Lambda exposed only through the shared public HTTP API. */
export class RoutePlanningStack extends Stack {
  public readonly routeFunction: lambda.DockerImageFunction;

  constructor(scope: Construct, id: string, props: RoutePlanningStackProps) {
    super(scope, id, props);

    Tags.of(this).add('Project', 'yukisaki-center');
    Tags.of(this).add('Environment', props.environment);
    Tags.of(this).add('Component', 'route-planning');
    Tags.of(this).add('ManagedBy', 'aws-cdk');

    const securityGroup = new ec2.SecurityGroup(this, 'RoutePlanningSecurityGroup', {
      vpc: props.databaseVpc,
      allowAllOutbound: true,
      description: 'PostgreSQL access for the pgRouting Lambda',
    });
    new ec2.CfnSecurityGroupIngress(this, 'UnifiedDatabaseIngressFromRoutePlanning', {
      groupId: props.database.connections.securityGroups[0].securityGroupId,
      sourceSecurityGroupId: securityGroup.securityGroupId,
      ipProtocol: 'tcp',
      fromPort: 5432,
      toPort: 5432,
      description: 'Allow PostgreSQL only from route planning',
    });

    const logGroup = new logs.LogGroup(this, 'RoutePlanningLogs', {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    this.routeFunction = new lambda.DockerImageFunction(this, 'RoutePlanningFunction', {
      architecture: lambda.Architecture.ARM_64,
      description: 'Snaps points and returns evidence-backed snow-road routes using PostGIS and pgRouting',
      code: lambda.DockerImageCode.fromImageAsset(
        path.join(__dirname, '../../../services/route-planning'),
        { target: 'runtime', platform: ecrAssets.Platform.LINUX_ARM64 },
      ),
      timeout: Duration.seconds(20),
      memorySize: 2048,
      reservedConcurrentExecutions: 0,
      logGroup,
      vpc: props.databaseVpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [securityGroup],
      environment: {
        DATABASE_NAME: props.databaseName,
        DATABASE_SECRET_ARN: props.databaseSecret.secretArn,
        TARGET_REFERENCE_TIME: props.targetReferenceTime,
      },
    });
    props.databaseSecret.grantRead(this.routeFunction);
    Tags.of(this.routeFunction).add('Lifecycle', 'runtime');
    Tags.of(this.routeFunction).add('Service', 'route-planning');

    new CfnOutput(this, 'RoutePlanningFunctionName', {
      value: this.routeFunction.functionName,
    });
  }
}
