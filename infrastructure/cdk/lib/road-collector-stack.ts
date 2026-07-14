import * as path from 'path';
import { CfnOutput, Duration, RemovalPolicy, Stack, StackProps, Tags } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecrAssets from 'aws-cdk-lib/aws-ecr-assets';
import * as events from 'aws-cdk-lib/aws-events';
import * as eventTargets from 'aws-cdk-lib/aws-events-targets';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';

export interface RoadCollectorStackProps extends StackProps {
  readonly environment: string;
  readonly scheduleHours: number;
}

/** An isolated OSM road collector. It deliberately has no dependency on DataPipelineStack. */
export class RoadCollectorStack extends Stack {
  constructor(scope: Construct, id: string, props: RoadCollectorStackProps) {
    super(scope, id, props);
    if (!Number.isInteger(props.scheduleHours) || props.scheduleHours < 1) {
      throw new Error('scheduleHours must be an integer greater than or equal to 1');
    }

    Tags.of(this).add('Project', 'yukisaki-center');
    Tags.of(this).add('Environment', props.environment);
    Tags.of(this).add('Component', 'road-collector');
    Tags.of(this).add('ManagedBy', 'aws-cdk');

    const roadBucket = new s3.Bucket(this, 'RoadDataBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,
      removalPolicy: RemovalPolicy.RETAIN,
      autoDeleteObjects: false,
      lifecycleRules: [{
        id: 'AbortIncompleteMultipartUploads',
        abortIncompleteMultipartUploadAfter: Duration.days(7),
      }],
    });
    const schedulerDlq = new sqs.Queue(this, 'RoadSchedulerDeadLetterQueue', {
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      retentionPeriod: Duration.days(14),
      enforceSSL: true,
    });
    const vpc = new ec2.Vpc(this, 'RoadTaskVpc', {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [{ name: 'Public', subnetType: ec2.SubnetType.PUBLIC }],
    });
    const cluster = new ecs.Cluster(this, 'RoadTaskCluster', { vpc });
    const logGroup = new logs.LogGroup(this, 'RoadTaskLogs', {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    const taskDefinition = new ecs.FargateTaskDefinition(this, 'RoadTaskDefinition', {
      cpu: 1024,
      memoryLimitMiB: 4096,
      ephemeralStorageGiB: 50,
    });
    taskDefinition.addContainer('RoadCollector', {
      image: ecs.ContainerImage.fromAsset(
        path.join(__dirname, '../../../services/data-ingestion'),
        { target: 'road-runtime', platform: ecrAssets.Platform.LINUX_AMD64 },
      ),
      logging: ecs.LogDrivers.awsLogs({ logGroup, streamPrefix: 'road' }),
      environment: {
        DATA_BUCKET: roadBucket.bucketName,
        ROAD_S3_DATASET: 'road-network',
        UPLOAD_TO_S3: 'true',
        AWS_REGION: this.region,
      },
    });
    roadBucket.grantPut(taskDefinition.taskRole, 'raw/osm/road-network/*');
    roadBucket.grantPut(taskDefinition.taskRole, 'manifests/data-ingestion/*');

    new events.Rule(this, 'RoadCollectionSchedule', {
      description: 'Runs the OpenStreetMap road collector as an isolated ECS Fargate task',
      schedule: events.Schedule.rate(Duration.hours(props.scheduleHours)),
      targets: [new eventTargets.EcsTask({
        cluster,
        taskDefinition,
        taskCount: 1,
        launchType: ecs.LaunchType.FARGATE,
        platformVersion: ecs.FargatePlatformVersion.VERSION1_4,
        assignPublicIp: true,
        subnetSelection: { subnetType: ec2.SubnetType.PUBLIC },
        deadLetterQueue: schedulerDlq,
        retryAttempts: 0,
      })],
    });

    new CfnOutput(this, 'RoadDataBucketName', { value: roadBucket.bucketName });
    new CfnOutput(this, 'RoadClusterName', { value: cluster.clusterName });
    new CfnOutput(this, 'RoadTaskDefinitionArn', { value: taskDefinition.taskDefinitionArn });
  }
}
