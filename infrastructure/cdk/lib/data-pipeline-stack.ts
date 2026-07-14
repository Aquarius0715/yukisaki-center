import * as path from 'path';
import {
  CfnOutput,
  Duration,
  RemovalPolicy,
  Stack,
  StackProps,
  Tags,
} from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as ecrAssets from 'aws-cdk-lib/aws-ecr-assets';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as events from 'aws-cdk-lib/aws-events';
import * as eventTargets from 'aws-cdk-lib/aws-events-targets';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3n from 'aws-cdk-lib/aws-s3-notifications';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import * as schedulerTargets from 'aws-cdk-lib/aws-scheduler-targets';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';

export interface DataPipelineStackProps extends StackProps {
  readonly environment: string;
  readonly scheduleMinutes: number;
  readonly roadScheduleHours: number;
  readonly weatherSourceUrl: string;
}

export class DataPipelineStack extends Stack {
  public readonly dataBucket: s3.Bucket;
  public readonly schedulerDlq: sqs.Queue;
  public readonly processingDlq: sqs.Queue;
  public readonly collectorFunction: lambda.DockerImageFunction;
  public readonly normalizerFunction: lambda.DockerImageFunction;
  public readonly roadTaskDefinition: ecs.FargateTaskDefinition;

  constructor(scope: Construct, id: string, props: DataPipelineStackProps) {
    super(scope, id, props);

    if (!Number.isInteger(props.scheduleMinutes) || props.scheduleMinutes < 1) {
      throw new Error('scheduleMinutes must be an integer greater than or equal to 1');
    }
    if (!Number.isInteger(props.roadScheduleHours) || props.roadScheduleHours < 1) {
      throw new Error('roadScheduleHours must be an integer greater than or equal to 1');
    }
    const sourceUrl = new URL(props.weatherSourceUrl);
    if (sourceUrl.protocol !== 'https:') {
      throw new Error('weatherSourceUrl must use HTTPS');
    }

    Tags.of(this).add('Project', 'yukisaki-center');
    Tags.of(this).add('Environment', props.environment);
    Tags.of(this).add('ManagedBy', 'aws-cdk');

    this.dataBucket = new s3.Bucket(this, 'DataBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,
      removalPolicy: RemovalPolicy.RETAIN,
      autoDeleteObjects: false,
      lifecycleRules: [
        {
          id: 'AbortIncompleteMultipartUploads',
          abortIncompleteMultipartUploadAfter: Duration.days(7),
        },
        {
          id: 'ExpireQuarantineAfter90Days',
          prefix: 'quarantine/',
          expiration: Duration.days(90),
          noncurrentVersionExpiration: Duration.days(30),
        },
      ],
    });

    this.schedulerDlq = new sqs.Queue(this, 'SchedulerDeadLetterQueue', {
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      retentionPeriod: Duration.days(14),
      enforceSSL: true,
    });
    this.processingDlq = new sqs.Queue(this, 'ProcessingDeadLetterQueue', {
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      retentionPeriod: Duration.days(14),
      enforceSSL: true,
    });

    const lambdaDefaults: Pick<lambda.DockerImageFunctionProps, 'architecture'> = {
      architecture: lambda.Architecture.ARM_64,
    };

    const collectorLogGroup = new logs.LogGroup(this, 'WeatherCollectorLogs', {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    const normalizerLogGroup = new logs.LogGroup(this, 'WeatherNormalizerLogs', {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    this.collectorFunction = new lambda.DockerImageFunction(this, 'WeatherCollector', {
      ...lambdaDefaults,
      description: 'Fetches the configured JMA feed and stores immutable raw data in S3',
      code: lambda.DockerImageCode.fromImageAsset(
        path.join(__dirname, '../../../services/data-ingestion'),
        {
          target: 'runtime',
          platform: ecrAssets.Platform.LINUX_ARM64,
        },
      ),
      timeout: Duration.seconds(30),
      memorySize: 256,
      logGroup: collectorLogGroup,
      environment: {
        DATA_BUCKET: this.dataBucket.bucketName,
        SOURCE_URL: props.weatherSourceUrl,
        ALLOWED_SOURCE_HOSTS: sourceUrl.hostname,
        DATASET: 'jma-weather-feed',
        MAX_RESPONSE_BYTES: String(10 * 1024 * 1024),
        USER_AGENT: 'yukisaki-center/0.1 (+data-pipeline)',
      },
      deadLetterQueue: this.processingDlq,
      retryAttempts: 0,
    });
    this.dataBucket.grantPut(this.collectorFunction, 'raw/jma/weather-feed/*');
    this.dataBucket.grantPut(this.collectorFunction, 'manifests/data-ingestion/*');

    this.normalizerFunction = new lambda.DockerImageFunction(this, 'WeatherNormalizer', {
      ...lambdaDefaults,
      description: 'Normalizes JMA Atom feed entries into JSON Lines',
      code: lambda.DockerImageCode.fromImageAsset(
        path.join(__dirname, '../../../services/data-processing'),
        {
          target: 'runtime',
          platform: ecrAssets.Platform.LINUX_ARM64,
        },
      ),
      timeout: Duration.seconds(60),
      memorySize: 512,
      logGroup: normalizerLogGroup,
      environment: {
        DATA_BUCKET: this.dataBucket.bucketName,
        SCHEMA_VERSION: '1.0.0',
      },
      deadLetterQueue: this.processingDlq,
      retryAttempts: 2,
    });
    this.dataBucket.grantRead(this.normalizerFunction, 'raw/jma/weather-feed/*');
    this.dataBucket.grantPut(this.normalizerFunction, 'normalized/jma-weather-feed/*');
    this.dataBucket.grantPut(this.normalizerFunction, 'quarantine/jma/weather-feed/*');
    this.dataBucket.grantPut(this.normalizerFunction, 'manifests/data-processing/*');
    this.dataBucket.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new s3n.LambdaDestination(this.normalizerFunction),
      { prefix: 'raw/jma/weather-feed/', suffix: '/response.xml' },
    );

    const roadVpc = new ec2.Vpc(this, 'RoadTaskVpc', {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [{
        name: 'Public',
        subnetType: ec2.SubnetType.PUBLIC,
      }],
    });
    const roadCluster = new ecs.Cluster(this, 'RoadTaskCluster', { vpc: roadVpc });
    const roadLogGroup = new logs.LogGroup(this, 'RoadTaskLogs', {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    this.roadTaskDefinition = new ecs.FargateTaskDefinition(this, 'RoadTaskDefinition', {
      cpu: 1024,
      memoryLimitMiB: 4096,
      ephemeralStorageGiB: 50,
    });
    this.roadTaskDefinition.addContainer('RoadCollector', {
      image: ecs.ContainerImage.fromAsset(
        path.join(__dirname, '../../../services/data-ingestion'),
        { target: 'road-runtime', platform: ecrAssets.Platform.LINUX_AMD64 },
      ),
      logging: ecs.LogDrivers.awsLogs({ logGroup: roadLogGroup, streamPrefix: 'road' }),
      environment: {
        DATA_BUCKET: this.dataBucket.bucketName,
        ROAD_S3_DATASET: 'road-network',
        UPLOAD_TO_S3: 'true',
        AWS_REGION: this.region,
      },
    });
    this.dataBucket.grantPut(this.roadTaskDefinition.taskRole, 'raw/osm/road-network/*');
    this.dataBucket.grantPut(this.roadTaskDefinition.taskRole, 'manifests/data-ingestion/*');

    const roadSchedule = new events.Rule(this, 'RoadCollectionSchedule', {
      description: 'Runs the OpenStreetMap road collector as an ECS Fargate task',
      schedule: events.Schedule.rate(Duration.hours(props.roadScheduleHours)),
    });
    roadSchedule.addTarget(new eventTargets.EcsTask({
      cluster: roadCluster,
      taskDefinition: this.roadTaskDefinition,
      taskCount: 1,
      launchType: ecs.LaunchType.FARGATE,
      platformVersion: ecs.FargatePlatformVersion.VERSION1_4,
      assignPublicIp: true,
      subnetSelection: { subnetType: ec2.SubnetType.PUBLIC },
      deadLetterQueue: this.schedulerDlq,
      retryAttempts: 0,
    }));

    const scheduleTarget = new schedulerTargets.LambdaInvoke(this.collectorFunction, {
      deadLetterQueue: this.schedulerDlq,
      retryAttempts: 2,
      maxEventAge: Duration.minutes(15),
      input: scheduler.ScheduleTargetInput.fromObject({
        dataset: 'jma-weather-feed',
        scheduledAt: scheduler.ContextAttribute.scheduledTime,
        executionId: scheduler.ContextAttribute.executionId,
      }),
    });
    new scheduler.Schedule(this, 'WeatherCollectionSchedule', {
      description: 'Periodically fetch the configured JMA weather feed',
      schedule: scheduler.ScheduleExpression.rate(Duration.minutes(props.scheduleMinutes)),
      target: scheduleTarget,
      timeWindow: scheduler.TimeWindow.off(),
    });

    this.createMonitoring();

    new CfnOutput(this, 'DataBucketName', { value: this.dataBucket.bucketName });
    new CfnOutput(this, 'CollectorFunctionName', {
      value: this.collectorFunction.functionName,
    });
    new CfnOutput(this, 'NormalizerFunctionName', {
      value: this.normalizerFunction.functionName,
    });
    new CfnOutput(this, 'RoadClusterName', { value: roadCluster.clusterName });
    new CfnOutput(this, 'RoadTaskDefinitionArn', { value: this.roadTaskDefinition.taskDefinitionArn });
    new CfnOutput(this, 'SchedulerDlqUrl', { value: this.schedulerDlq.queueUrl });
    new CfnOutput(this, 'ProcessingDlqUrl', { value: this.processingDlq.queueUrl });
  }

  private createMonitoring(): void {
    const collectorErrors = this.collectorFunction.metricErrors({
      period: Duration.minutes(5),
      statistic: 'sum',
    });
    const normalizerErrors = this.normalizerFunction.metricErrors({
      period: Duration.minutes(5),
      statistic: 'sum',
    });

    new cloudwatch.Alarm(this, 'CollectorErrorsAlarm', {
      metric: collectorErrors,
      threshold: 1,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: 'Weather collector Lambda failed',
    });
    new cloudwatch.Alarm(this, 'NormalizerErrorsAlarm', {
      metric: normalizerErrors,
      threshold: 1,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: 'Weather normalizer Lambda failed',
    });
    new cloudwatch.Alarm(this, 'SchedulerDlqMessagesAlarm', {
      metric: this.schedulerDlq.metricApproximateNumberOfMessagesVisible({
        period: Duration.minutes(5),
        statistic: 'max',
      }),
      threshold: 1,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: 'EventBridge Scheduler has undelivered events',
    });
    new cloudwatch.Alarm(this, 'ProcessingDlqMessagesAlarm', {
      metric: this.processingDlq.metricApproximateNumberOfMessagesVisible({
        period: Duration.minutes(5),
        statistic: 'max',
      }),
      threshold: 1,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: 'Asynchronous Lambda processing has failed',
    });

    const dashboard = new cloudwatch.Dashboard(this, 'DataPipelineDashboard');
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Lambda errors',
        left: [collectorErrors, normalizerErrors],
      }),
      new cloudwatch.GraphWidget({
        title: 'Lambda duration',
        left: [
          this.collectorFunction.metricDuration({ statistic: 'p95' }),
          this.normalizerFunction.metricDuration({ statistic: 'p95' }),
        ],
      }),
      new cloudwatch.SingleValueWidget({
        title: 'Dead-letter queue messages',
        metrics: [
          this.schedulerDlq.metricApproximateNumberOfMessagesVisible(),
          this.processingDlq.metricApproximateNumberOfMessagesVisible(),
        ],
      }),
    );
  }
}
