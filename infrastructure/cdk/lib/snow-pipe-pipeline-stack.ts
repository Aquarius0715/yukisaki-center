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
import * as cloudtrail from 'aws-cdk-lib/aws-cloudtrail';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecrAssets from 'aws-cdk-lib/aws-ecr-assets';
import * as events from 'aws-cdk-lib/aws-events';
import * as eventTargets from 'aws-cdk-lib/aws-events-targets';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import { Construct } from 'constructs';

export interface SnowPipePipelineStackProps extends StackProps {
  readonly environment: string;
  readonly targetReferenceTime: string;
  readonly roadBucket: s3.IBucket;
  readonly databaseVpc: ec2.IVpc;
  readonly database: rds.IDatabaseInstance;
  readonly databaseSecret: secretsmanager.ISecret;
  readonly databaseName: string;
  readonly manifestRuleEnabled: boolean;
}

/** Event-driven simulated snow-pipe enrichment and rebuildable PostgreSQL projection. */
export class SnowPipePipelineStack extends Stack {
  public readonly dataBucket: s3.Bucket;
  public readonly loaderFunction: lambda.DockerImageFunction;
  public readonly stateMachine: sfn.StateMachine;
  public readonly loadQueue: sqs.Queue;

  constructor(scope: Construct, id: string, props: SnowPipePipelineStackProps) {
    super(scope, id, props);
    if (Number.isNaN(new Date(props.targetReferenceTime).valueOf())) {
      throw new Error('targetReferenceTime must be an ISO 8601 timestamp');
    }
    this.dataBucket = new s3.Bucket(this, 'SnowPipeDataBucket', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: true,
      removalPolicy: RemovalPolicy.RETAIN,
      autoDeleteObjects: false,
    });
    Tags.of(this).add('Project', 'yukisaki-center');
    Tags.of(this).add('Environment', props.environment);
    Tags.of(this).add('Component', 'snow-pipe-pipeline');
    Tags.of(this).add('ManagedBy', 'aws-cdk');

    const workflowDlq = new sqs.Queue(this, 'SnowPipeWorkflowDeadLetterQueue', {
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      retentionPeriod: Duration.days(14),
      enforceSSL: true,
    });
    const loadDlq = new sqs.Queue(this, 'RoadDatabaseLoadDeadLetterQueue', {
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      retentionPeriod: Duration.days(14),
      enforceSSL: true,
    });
    this.loadQueue = new sqs.Queue(this, 'RoadDatabaseLoadQueue', {
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      visibilityTimeout: Duration.minutes(6),
      retentionPeriod: Duration.days(14),
      enforceSSL: true,
      deadLetterQueue: { queue: loadDlq, maxReceiveCount: 3 },
    });

    const generatorLogs = new logs.LogGroup(this, 'SnowPipeGeneratorLogs', {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const generator = new lambda.DockerImageFunction(this, 'SnowPipeGenerator', {
      architecture: lambda.Architecture.ARM_64,
      description: 'Generates simulated snow-pipe records from a completed road manifest',
      code: lambda.DockerImageCode.fromImageAsset(
        path.join(__dirname, '../../../services/data-ingestion'),
        {
          target: 'runtime',
          platform: ecrAssets.Platform.LINUX_ARM64,
          cmd: ['data_ingestion.snow_pipe.generator.handler'],
        },
      ),
      timeout: Duration.minutes(10),
      memorySize: 2048,
      logGroup: generatorLogs,
      environment: {
        TARGET_REFERENCE_TIME: props.targetReferenceTime,
        SNOW_DATA_BUCKET_NAME: this.dataBucket.bucketName,
      },
    });
    props.roadBucket.grantRead(generator, 'raw/osm/road-network/*');
    props.roadBucket.grantRead(generator, 'manifests/data-ingestion/*');
    this.dataBucket.grantPut(generator, 'raw/simulated/snow-pipe/*');
    this.dataBucket.grantPut(generator, 'manifests/data-ingestion/*');

    const mergerLogs = new logs.LogGroup(this, 'RoadSnowPipeMergerLogs', {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const merger = new lambda.DockerImageFunction(this, 'RoadSnowPipeMerger', {
      architecture: lambda.Architecture.ARM_64,
      description: 'Merges verified roads and simulated snow-pipe data into an S3 curated snapshot',
      code: lambda.DockerImageCode.fromImageAsset(
        path.join(__dirname, '../../../services/data-processing'),
        {
          target: 'lambda-loader',
          platform: ecrAssets.Platform.LINUX_ARM64,
          cmd: ['data_processing.snow_pipe.pipeline.merge_handler'],
        },
      ),
      timeout: Duration.minutes(10),
      memorySize: 3008,
      logGroup: mergerLogs,
    });
    props.roadBucket.grantRead(merger, 'raw/osm/road-network/*');
    this.dataBucket.grantRead(merger, 'raw/simulated/snow-pipe/*');
    this.dataBucket.grantPut(merger, 'curated/road-segments/*');
    this.dataBucket.grantPut(merger, 'manifests/data-processing/*');

    const loaderSecurityGroup = new ec2.SecurityGroup(this, 'RoadDatabaseLoaderSecurityGroup', {
      vpc: props.databaseVpc,
      allowAllOutbound: true,
      description: 'Security group for the curated road and snow-pipe PostgreSQL loader',
    });
    const loaderLogs = new logs.LogGroup(this, 'RoadDatabaseLoaderLogs', {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    this.loaderFunction = new lambda.DockerImageFunction(this, 'RoadDatabaseLoader', {
      architecture: lambda.Architecture.ARM_64,
      description: 'Loads verified curated road and snow-pipe snapshots into PostgreSQL',
      code: lambda.DockerImageCode.fromImageAsset(
        path.join(__dirname, '../../../services/data-processing'),
        {
          target: 'lambda-loader',
          platform: ecrAssets.Platform.LINUX_ARM64,
          cmd: ['data_processing.snow_pipe.pipeline.loader_handler'],
        },
      ),
      timeout: Duration.minutes(15),
      memorySize: 3008,
      // RDS is normally stopped. env:start removes this limit only after the
      // database is available, allowing SQS to retain load requests meanwhile.
      reservedConcurrentExecutions: 0,
      logGroup: loaderLogs,
      vpc: props.databaseVpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [loaderSecurityGroup],
      environment: {
        DATABASE_NAME: props.databaseName,
        DATABASE_SECRET_ARN: props.databaseSecret.secretArn,
      },
    });
    new ec2.CfnSecurityGroupIngress(this, 'UnifiedDatabaseIngressFromSnowPipeLoader', {
      groupId: props.database.connections.securityGroups[0].securityGroupId,
      sourceSecurityGroupId: loaderSecurityGroup.securityGroupId,
      ipProtocol: 'tcp',
      fromPort: 5432,
      toPort: 5432,
      description: 'Allow PostgreSQL only from the Snow Pipe loader',
    });
    props.databaseSecret.grantRead(this.loaderFunction);
    this.dataBucket.grantRead(this.loaderFunction, 'curated/road-segments/*');
    this.loaderFunction.addEventSource(new lambdaEventSources.SqsEventSource(this.loadQueue, {
      batchSize: 1,
      reportBatchItemFailures: true,
    }));

    const generate = new tasks.LambdaInvoke(this, 'GenerateSimulatedSnowPipe', {
      lambdaFunction: generator,
      payloadResponseOnly: true,
      retryOnServiceExceptions: true,
    });
    const merge = new tasks.LambdaInvoke(this, 'MergeRoadAndSnowPipe', {
      lambdaFunction: merger,
      payloadResponseOnly: true,
      retryOnServiceExceptions: true,
    });
    const enqueue = new tasks.SqsSendMessage(this, 'EnqueuePostgreSqlLoad', {
      queue: this.loadQueue,
      messageBody: sfn.TaskInput.fromJsonPathAt('$'),
    });
    const workflowLogs = new logs.LogGroup(this, 'SnowPipeWorkflowLogs', {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    this.stateMachine = new sfn.StateMachine(this, 'SnowPipeStateMachine', {
      definitionBody: sfn.DefinitionBody.fromChainable(generate.next(merge).next(enqueue)),
      stateMachineType: sfn.StateMachineType.STANDARD,
      timeout: Duration.minutes(15),
      logs: { destination: workflowLogs, level: sfn.LogLevel.ERROR },
      tracingEnabled: true,
    });

    // The existing road bucket is owned by another stack. CloudTrail data events
    // let this stack observe manifest writes without changing that bucket or the
    // road collector stack's notification configuration.
    const manifestTrail = new cloudtrail.Trail(this, 'RoadManifestDataTrail', {
      isMultiRegionTrail: false,
      includeGlobalServiceEvents: false,
      managementEvents: cloudtrail.ReadWriteType.NONE,
      sendToCloudWatchLogs: false,
    });
    manifestTrail.addS3EventSelector([{
      bucket: props.roadBucket,
      objectPrefix: 'manifests/data-ingestion/',
    }], { readWriteType: cloudtrail.ReadWriteType.WRITE_ONLY });

    const manifestRule = new events.Rule(this, 'RoadManifestCreatedRule', {
      description: 'Starts snow-pipe enrichment after a complete road manifest is written',
      enabled: props.manifestRuleEnabled,
      eventPattern: {
        source: ['aws.s3'],
        detailType: ['AWS API Call via CloudTrail'],
        detail: {
          eventSource: ['s3.amazonaws.com'],
          eventName: ['PutObject', 'CompleteMultipartUpload', 'CopyObject'],
          requestParameters: {
            bucketName: [props.roadBucket.bucketName],
            key: [{ prefix: 'manifests/data-ingestion/' }],
          },
        },
      },
    });
    manifestRule.addTarget(new eventTargets.SfnStateMachine(this.stateMachine, {
      deadLetterQueue: workflowDlq,
      retryAttempts: 2,
      maxEventAge: Duration.hours(1),
    }));

    for (const [id, queue] of [
      ['SnowPipeWorkflowDlqAlarm', workflowDlq],
      ['RoadDatabaseLoadDlqAlarm', loadDlq],
    ] as const) {
      new cloudwatch.Alarm(this, id, {
        metric: queue.metricApproximateNumberOfMessagesVisible({
          period: Duration.minutes(5), statistic: 'max',
        }),
        threshold: 1,
        evaluationPeriods: 1,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });
    }
    new cloudwatch.Alarm(this, 'SnowPipeWorkflowFailuresAlarm', {
      metric: this.stateMachine.metricFailed({ period: Duration.minutes(5), statistic: 'sum' }),
      threshold: 1,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    new CfnOutput(this, 'SnowPipeStateMachineArn', { value: this.stateMachine.stateMachineArn });
    new CfnOutput(this, 'SnowPipeDataBucketName', { value: this.dataBucket.bucketName });
    new CfnOutput(this, 'SnowPipeManifestRuleName', { value: manifestRule.ruleName });
    new CfnOutput(this, 'RoadDatabaseLoaderFunctionName', { value: this.loaderFunction.functionName });
    new CfnOutput(this, 'RoadDatabaseLoadQueueUrl', { value: this.loadQueue.queueUrl });
    new CfnOutput(this, 'RoadDatabaseLoadDlqUrl', { value: loadDlq.queueUrl });
    new CfnOutput(this, 'SnowPipeWorkflowDlqUrl', { value: workflowDlq.queueUrl });
  }
}
