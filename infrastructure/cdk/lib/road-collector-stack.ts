import * as path from 'path';
import { CfnOutput, Duration, RemovalPolicy, Stack, StackProps, Tags } from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
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
  readonly scheduleEnabled: boolean;
  readonly scheduleHours: number;
}

/** An isolated OSM road collector. It deliberately has no dependency on DataPipelineStack. */
export class RoadCollectorStack extends Stack {
  public readonly dataBucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: RoadCollectorStackProps) {
    super(scope, id, props);
    if (!Number.isInteger(props.scheduleHours) || props.scheduleHours < 1) {
      throw new Error('scheduleHours must be an integer greater than or equal to 1');
    }

    Tags.of(this).add('Project', 'yukisaki-center');
    Tags.of(this).add('Environment', props.environment);
    Tags.of(this).add('Component', 'road-collector');
    Tags.of(this).add('ManagedBy', 'aws-cdk');

    this.dataBucket = new s3.Bucket(this, 'RoadDataBucket', {
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
    Tags.of(this.dataBucket).add('Service', 'data-platform');
    Tags.of(this.dataBucket).add('Component', 'road-collector');
    Tags.of(this.dataBucket).add('Lifecycle', 'persistent');
    const schedulerDlq = new sqs.Queue(this, 'RoadSchedulerDeadLetterQueue', {
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      retentionPeriod: Duration.days(14),
      enforceSSL: true,
    });
    Tags.of(schedulerDlq).add('Service', 'data-ingestion');
    Tags.of(schedulerDlq).add('Component', 'road-collector');
    Tags.of(schedulerDlq).add('Lifecycle', 'persistent');
    const vpc = new ec2.Vpc(this, 'RoadTaskVpc', {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [{ name: 'Public', subnetType: ec2.SubnetType.PUBLIC }],
    });
    Tags.of(vpc).add('Service', 'data-ingestion');
    Tags.of(vpc).add('Component', 'road-collector');
    Tags.of(vpc).add('Lifecycle', 'persistent');
    const cluster = new ecs.Cluster(this, 'RoadTaskCluster', { vpc });
    Tags.of(cluster).add('Service', 'data-ingestion');
    Tags.of(cluster).add('Component', 'road-collector');
    Tags.of(cluster).add('Lifecycle', 'persistent');
    const logGroup = new logs.LogGroup(this, 'RoadTaskLogs', {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    Tags.of(logGroup).add('Service', 'data-ingestion');
    Tags.of(logGroup).add('Component', 'road-collector');
    Tags.of(logGroup).add('Lifecycle', 'persistent');
    const taskDefinition = new ecs.FargateTaskDefinition(this, 'RoadTaskDefinition', {
      cpu: 2048,
      memoryLimitMiB: 8192,
      ephemeralStorageGiB: 50,
    });
    Tags.of(taskDefinition).add('Service', 'data-ingestion');
    Tags.of(taskDefinition).add('Component', 'road-collector');
    Tags.of(taskDefinition).add('Lifecycle', 'on-demand');
    taskDefinition.addContainer('RoadCollector', {
      image: ecs.ContainerImage.fromAsset(
        path.join(__dirname, '../../../services/data-ingestion'),
        { target: 'road-runtime', platform: ecrAssets.Platform.LINUX_AMD64 },
      ),
      logging: ecs.LogDrivers.awsLogs({ logGroup, streamPrefix: 'road' }),
      environment: {
        DATA_BUCKET: this.dataBucket.bucketName,
        ROAD_S3_DATASET: 'road-network',
        UPLOAD_TO_S3: 'true',
        AWS_REGION: this.region,
        OSM_PLACE_NAME: '新潟県長岡市',
      },
    });
    this.dataBucket.grantPut(taskDefinition.taskRole, 'raw/osm/road-network/*');
    this.dataBucket.grantPut(taskDefinition.taskRole, 'manifests/data-ingestion/*');

    const collectionSchedule = new events.Rule(this, 'RoadCollectionSchedule', {
      description: 'Runs the OpenStreetMap road collector as an isolated ECS Fargate task',
      enabled: props.scheduleEnabled,
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
    Tags.of(collectionSchedule).add('Service', 'data-ingestion');
    Tags.of(collectionSchedule).add('Component', 'road-collector');
    Tags.of(collectionSchedule).add('Lifecycle', 'runtime');

    new cloudwatch.Alarm(this, 'RoadScheduleDlqMessagesAlarm', {
      metric: schedulerDlq.metricApproximateNumberOfMessagesVisible({
        period: Duration.minutes(5),
        statistic: 'max',
      }),
      threshold: 1,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    new CfnOutput(this, 'RoadDataBucketName', { value: this.dataBucket.bucketName });
    new CfnOutput(this, 'RoadClusterName', { value: cluster.clusterName });
    new CfnOutput(this, 'RoadTaskDefinitionArn', { value: taskDefinition.taskDefinitionArn });
    new CfnOutput(this, 'RoadScheduleName', { value: collectionSchedule.ruleName });
    new CfnOutput(this, 'RoadScheduleDlqUrl', { value: schedulerDlq.queueUrl });
  }
}
