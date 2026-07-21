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
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecrAssets from 'aws-cdk-lib/aws-ecr-assets';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as kinesis from 'aws-cdk-lib/aws-kinesis';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';

export interface GpsPipelineStackProps extends StackProps {
  readonly environment: string;
  readonly targetReferenceTime: string;
  readonly targetLatitude: number;
  readonly targetLongitude: number;
  readonly simulatorEnabled: boolean;
  readonly emitIntervalSeconds: number;
  readonly dataBucket: s3.IBucket;
  readonly roadCuratedBucket: s3.IBucket;
  readonly databaseVpc: ec2.IVpc;
  readonly database: rds.IDatabaseInstance;
  readonly databaseSecret: secretsmanager.ISecret;
  readonly databaseName: string;
}

/** Real-time simulated snowplow GPS, S3 truth, PostgreSQL projection, and deterministic scoring. */
export class GpsPipelineStack extends Stack {
  public readonly stream: kinesis.Stream;
  public readonly cluster: ecs.Cluster;
  public readonly simulatorService: ecs.FargateService;
  public readonly archiverFunction: lambda.DockerImageFunction;
  public readonly processorFunction: lambda.DockerImageFunction;
  public readonly loaderFunction: lambda.DockerImageFunction;
  public readonly scoringFunction: lambda.DockerImageFunction;

  constructor(scope: Construct, id: string, props: GpsPipelineStackProps) {
    super(scope, id, props);
    if (Number.isNaN(new Date(props.targetReferenceTime).valueOf())) {
      throw new Error('targetReferenceTime must be an ISO 8601 timestamp');
    }
    if (!Number.isInteger(props.emitIntervalSeconds) || props.emitIntervalSeconds < 1) {
      throw new Error('emitIntervalSeconds must be a positive integer');
    }
    Tags.of(this).add('Project', 'yukisaki-center');
    Tags.of(this).add('Environment', props.environment);
    Tags.of(this).add('Component', 'plow-gps-pipeline');
    Tags.of(this).add('ManagedBy', 'aws-cdk');

    this.stream = new kinesis.Stream(this, 'GpsEventStream', {
      streamMode: kinesis.StreamMode.PROVISIONED,
      shardCount: 1,
      encryption: kinesis.StreamEncryption.MANAGED,
      retentionPeriod: Duration.hours(24),
    });
    Tags.of(this.stream).add('Lifecycle', 'persistent');
    Tags.of(this.stream).add('Service', 'data-platform');

    this.cluster = new ecs.Cluster(this, 'GpsSimulatorCluster', {
      vpc: props.databaseVpc,
      containerInsightsV2: ecs.ContainerInsights.DISABLED,
    });
    const simulatorLogs = new logs.LogGroup(this, 'GpsSimulatorLogs', {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const simulatorTask = new ecs.FargateTaskDefinition(this, 'GpsSimulatorTask', {
      cpu: 256,
      memoryLimitMiB: 512,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.ARM64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });
    simulatorTask.addContainer('GpsSimulator', {
      image: ecs.ContainerImage.fromAsset(path.join(__dirname, '../../../services/gps-simulator'), {
        platform: ecrAssets.Platform.LINUX_ARM64,
        target: 'runtime',
      }),
      logging: ecs.LogDrivers.awsLogs({ logGroup: simulatorLogs, streamPrefix: 'gps' }),
      environment: {
        ROAD_BUCKET_NAME: props.roadCuratedBucket.bucketName,
        GPS_STREAM_NAME: this.stream.streamName,
        VEHICLE_COUNT: '3',
        EMIT_INTERVAL_SECONDS: String(props.emitIntervalSeconds),
        SCENARIO_START_TIME: props.targetReferenceTime,
        TARGET_LATITUDE: String(props.targetLatitude),
        TARGET_LONGITUDE: String(props.targetLongitude),
        SPEED_KMH: '18',
      },
    });
    props.roadCuratedBucket.grantRead(simulatorTask.taskRole, 'curated/road-segments/*');
    this.stream.grantWrite(simulatorTask.taskRole);
    this.simulatorService = new ecs.FargateService(this, 'GpsSimulatorService', {
      cluster: this.cluster,
      taskDefinition: simulatorTask,
      desiredCount: props.simulatorEnabled ? 1 : 0,
      assignPublicIp: true,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      minHealthyPercent: 0,
      maxHealthyPercent: 100,
      circuitBreaker: { rollback: true },
    });
    Tags.of(this.simulatorService).add('Lifecycle', 'runtime');
    Tags.of(this.simulatorService).add('Service', 'gps-simulator');

    const streamFailureDlq = this.deadLetterQueue('GpsStreamFailureDeadLetterQueue');
    const loadDlq = this.deadLetterQueue('GpsDatabaseLoadDeadLetterQueue');
    const scoringDlq = this.deadLetterQueue('GpsScoringDeadLetterQueue');
    const loadQueue = new sqs.Queue(this, 'GpsDatabaseLoadQueue', {
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      retentionPeriod: Duration.days(14),
      visibilityTimeout: Duration.minutes(6),
      deadLetterQueue: { queue: loadDlq, maxReceiveCount: 5 },
    });
    const scoringQueue = new sqs.Queue(this, 'GpsScoringQueue', {
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      retentionPeriod: Duration.days(14),
      visibilityTimeout: Duration.minutes(6),
      deadLetterQueue: { queue: scoringDlq, maxReceiveCount: 5 },
    });

    this.archiverFunction = this.imageFunction('GpsRawArchiver', {
      servicePath: '../../../services/data-ingestion', target: 'runtime',
      command: 'data_ingestion.plow_gps.archiver.handler',
      description: 'Archives validated simulated snowplow GPS events into immutable S3 raw JSON Lines',
      memorySize: 512,
      environment: { DATA_BUCKET: props.dataBucket.bucketName, GPS_STREAM_NAME: this.stream.streamName },
    });
    props.dataBucket.grantPut(this.archiverFunction, 'raw/simulated/plow-gps/*');
    props.dataBucket.grantPut(this.archiverFunction, 'manifests/data-ingestion/*');

    this.processorFunction = this.imageFunction('GpsMapMatcher', {
      servicePath: '../../../services/data-processing', target: 'lambda-loader',
      command: 'data_processing.plow_gps.pipeline.processor_handler',
      description: 'Map-matches GPS events and writes normalized and curated S3 batches',
      memorySize: 1024,
      environment: {
        DATA_BUCKET: props.dataBucket.bucketName,
        ROAD_CURATED_BUCKET: props.roadCuratedBucket.bucketName,
        GPS_LOAD_QUEUE_URL: loadQueue.queueUrl,
        SCORING_QUEUE_URL: scoringQueue.queueUrl,
        SCORING_DELAY_SECONDS: '60',
      },
    });
    props.roadCuratedBucket.grantRead(this.processorFunction, 'curated/road-segments/*');
    props.dataBucket.grantPut(this.processorFunction, 'normalized/simulated/plow-gps/*');
    props.dataBucket.grantPut(this.processorFunction, 'curated/snowplow-passages/*');
    props.dataBucket.grantPut(this.processorFunction, 'manifests/data-processing/*');
    loadQueue.grantSendMessages(this.processorFunction);
    scoringQueue.grantSendMessages(this.processorFunction);

    for (const fn of [this.archiverFunction, this.processorFunction]) {
      fn.addEventSource(new lambdaEventSources.KinesisEventSource(this.stream, {
        startingPosition: lambda.StartingPosition.LATEST,
        batchSize: 100,
        maxBatchingWindow: Duration.seconds(10),
        retryAttempts: 3,
        bisectBatchOnError: true,
        onFailure: new lambdaEventSources.SqsDlq(streamFailureDlq),
      }));
    }

    const databaseConsumersSecurityGroup = new ec2.SecurityGroup(this, 'GpsDatabaseConsumersSecurityGroup', {
      vpc: props.databaseVpc,
      allowAllOutbound: true,
      description: 'PostgreSQL access for GPS loader and drivability scorer only',
    });
    new ec2.CfnSecurityGroupIngress(this, 'UnifiedDatabaseIngressFromGpsConsumers', {
      groupId: props.database.connections.securityGroups[0].securityGroupId,
      sourceSecurityGroupId: databaseConsumersSecurityGroup.securityGroupId,
      ipProtocol: 'tcp', fromPort: 5432, toPort: 5432,
      description: 'Allow PostgreSQL only from GPS processing consumers',
    });

    this.loaderFunction = this.imageFunction('GpsDatabaseLoader', {
      servicePath: '../../../services/data-processing', target: 'lambda-loader',
      command: 'data_processing.plow_gps.pipeline.loader_handler',
      description: 'Loads verified S3 curated snowplow positions and passages into PostgreSQL',
      memorySize: 1024,
      vpc: props.databaseVpc,
      securityGroups: [databaseConsumersSecurityGroup],
      environment: {
        DATABASE_NAME: props.databaseName,
        DATABASE_SECRET_ARN: props.databaseSecret.secretArn,
      },
    });
    props.databaseSecret.grantRead(this.loaderFunction);
    props.dataBucket.grantRead(this.loaderFunction, 'curated/snowplow-passages/*');
    this.loaderFunction.addEventSource(new lambdaEventSources.SqsEventSource(loadQueue, {
      batchSize: 1,
      reportBatchItemFailures: true,
    }));

    this.scoringFunction = this.imageFunction('DrivabilityScorer', {
      servicePath: '../../../services/drivability-scoring', target: 'runtime',
      command: 'drivability_scoring.pipeline.handler',
      description: 'Calculates deterministic drivability scores after GPS passage loading',
      memorySize: 1024,
      vpc: props.databaseVpc,
      securityGroups: [databaseConsumersSecurityGroup],
      environment: {
        DATABASE_NAME: props.databaseName,
        DATABASE_SECRET_ARN: props.databaseSecret.secretArn,
        DATA_BUCKET: props.dataBucket.bucketName,
      },
    });
    props.databaseSecret.grantRead(this.scoringFunction);
    props.dataBucket.grantPut(this.scoringFunction, 'curated/drivability-scores/*');
    this.scoringFunction.addEventSource(new lambdaEventSources.SqsEventSource(scoringQueue, {
      batchSize: 1,
      reportBatchItemFailures: true,
    }));

    for (const [id, queue] of [
      ['GpsStreamFailureDlqAlarm', streamFailureDlq],
      ['GpsDatabaseLoadDlqAlarm', loadDlq],
      ['GpsScoringDlqAlarm', scoringDlq],
    ] as const) {
      new cloudwatch.Alarm(this, id, {
        metric: queue.metricApproximateNumberOfMessagesVisible({
          period: Duration.minutes(5), statistic: 'max',
        }),
        threshold: 1, evaluationPeriods: 1,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });
    }

    new CfnOutput(this, 'GpsStreamName', { value: this.stream.streamName });
    new CfnOutput(this, 'GpsSimulatorClusterName', { value: this.cluster.clusterName });
    new CfnOutput(this, 'GpsSimulatorServiceName', { value: this.simulatorService.serviceName });
    new CfnOutput(this, 'GpsRawArchiverFunctionName', { value: this.archiverFunction.functionName });
    new CfnOutput(this, 'GpsMapMatcherFunctionName', { value: this.processorFunction.functionName });
    new CfnOutput(this, 'GpsDatabaseLoaderFunctionName', { value: this.loaderFunction.functionName });
    new CfnOutput(this, 'DrivabilityScorerFunctionName', { value: this.scoringFunction.functionName });
    new CfnOutput(this, 'GpsDatabaseLoadQueueUrl', { value: loadQueue.queueUrl });
    new CfnOutput(this, 'GpsDatabaseLoadDlqUrl', { value: loadDlq.queueUrl });
    new CfnOutput(this, 'GpsScoringQueueUrl', { value: scoringQueue.queueUrl });
    new CfnOutput(this, 'GpsScoringDlqUrl', { value: scoringDlq.queueUrl });
    new CfnOutput(this, 'GpsStreamFailureDlqUrl', { value: streamFailureDlq.queueUrl });
  }

  private deadLetterQueue(id: string): sqs.Queue {
    return new sqs.Queue(this, id, {
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      retentionPeriod: Duration.days(14),
    });
  }

  private imageFunction(id: string, options: {
    servicePath: string;
    target: string;
    command: string;
    description: string;
    memorySize: number;
    environment: Record<string, string>;
    vpc?: ec2.IVpc;
    securityGroups?: ec2.ISecurityGroup[];
  }): lambda.DockerImageFunction {
    const logGroup = new logs.LogGroup(this, `${id}Logs`, {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    return new lambda.DockerImageFunction(this, id, {
      architecture: lambda.Architecture.ARM_64,
      description: options.description,
      code: lambda.DockerImageCode.fromImageAsset(path.join(__dirname, options.servicePath), {
        target: options.target,
        platform: ecrAssets.Platform.LINUX_ARM64,
        cmd: [options.command],
      }),
      timeout: Duration.minutes(5),
      memorySize: options.memorySize,
      reservedConcurrentExecutions: 0,
      logGroup,
      environment: options.environment,
      vpc: options.vpc,
      vpcSubnets: options.vpc ? { subnetType: ec2.SubnetType.PRIVATE_ISOLATED } : undefined,
      securityGroups: options.securityGroups,
    });
  }
}
