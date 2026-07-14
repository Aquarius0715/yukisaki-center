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
import * as events from 'aws-cdk-lib/aws-events';
import * as eventTargets from 'aws-cdk-lib/aws-events-targets';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3n from 'aws-cdk-lib/aws-s3-notifications';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';

export interface DataPipelineStackProps extends StackProps {
  readonly environment: string;
  readonly scheduleEnabled: boolean;
  readonly scheduleHours: number;
  readonly targetReferenceTime: string;
  readonly targetLatitude: number;
  readonly targetLongitude: number;
}

export class DataPipelineStack extends Stack {
  public readonly dataBucket: s3.Bucket;
  public readonly processingDlq: sqs.Queue;
  public readonly scheduleDlq: sqs.Queue;
  public readonly collectorFunction: lambda.DockerImageFunction;
  public readonly loaderFunction: lambda.DockerImageFunction;
  public readonly database: rds.DatabaseInstance;
  public readonly collectionSchedule: events.Rule;

  constructor(scope: Construct, id: string, props: DataPipelineStackProps) {
    super(scope, id, props);

    const referenceTime = new Date(props.targetReferenceTime);
    if (Number.isNaN(referenceTime.valueOf())) {
      throw new Error('targetReferenceTime must be an ISO 8601 timestamp');
    }
    if (!Number.isInteger(props.scheduleHours) || props.scheduleHours < 1) {
      throw new Error('scheduleHours must be an integer greater than or equal to 1');
    }
    if (!Number.isFinite(props.targetLatitude) || !Number.isFinite(props.targetLongitude)) {
      throw new Error('target coordinates must be finite numbers');
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
    Tags.of(this.dataBucket).add('Service', 'data-platform');
    Tags.of(this.dataBucket).add('Component', 'weather-data');
    Tags.of(this.dataBucket).add('Lifecycle', 'persistent');

    const vpc = new ec2.Vpc(this, 'DatabaseVpc', {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        {
          name: 'isolated',
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
          cidrMask: 24,
        },
      ],
    });
    vpc.addGatewayEndpoint('S3Endpoint', {
      service: ec2.GatewayVpcEndpointAwsService.S3,
    });
    const secretsManagerEndpoint = vpc.addInterfaceEndpoint('SecretsManagerEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER,
      privateDnsEnabled: true,
      // The MVP database is Single-AZ. One endpoint ENI keeps private access while
      // avoiding a second fixed hourly charge during development.
      subnets: { subnets: [vpc.isolatedSubnets[0]] },
    });
    Tags.of(secretsManagerEndpoint).add('Service', 'data-processing');
    Tags.of(secretsManagerEndpoint).add('Component', 'weather-loader');
    Tags.of(secretsManagerEndpoint).add('Lifecycle', 'runtime');

    this.database = new rds.DatabaseInstance(this, 'WeatherDatabase', {
      engine: rds.DatabaseInstanceEngine.postgres({
        version: rds.PostgresEngineVersion.VER_16,
      }),
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.MICRO),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      credentials: rds.Credentials.fromGeneratedSecret('yukisaki_admin'),
      databaseName: 'yukisaki',
      allocatedStorage: 20,
      maxAllocatedStorage: 100,
      storageType: rds.StorageType.GP3,
      storageEncrypted: true,
      multiAz: false,
      publiclyAccessible: false,
      deletionProtection: false,
      backupRetention: Duration.days(1),
      deleteAutomatedBackups: true,
      removalPolicy: RemovalPolicy.DESTROY,
      cloudwatchLogsExports: ['postgresql'],
    });
    this.database.secret?.applyRemovalPolicy(RemovalPolicy.DESTROY);
    Tags.of(this.database).add('Service', 'data-processing');
    Tags.of(this.database).add('Component', 'weather-database');
    Tags.of(this.database).add('Lifecycle', 'runtime');

    this.processingDlq = new sqs.Queue(this, 'ProcessingDeadLetterQueue', {
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      retentionPeriod: Duration.days(14),
      enforceSSL: true,
    });
    Tags.of(this.processingDlq).add('Service', 'data-platform');
    Tags.of(this.processingDlq).add('Component', 'weather-processing');
    Tags.of(this.processingDlq).add('Lifecycle', 'persistent');

    this.scheduleDlq = new sqs.Queue(this, 'WeatherSchedulerDeadLetterQueue', {
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      retentionPeriod: Duration.days(14),
      enforceSSL: true,
    });
    Tags.of(this.scheduleDlq).add('Service', 'data-ingestion');
    Tags.of(this.scheduleDlq).add('Component', 'weather-collector');
    Tags.of(this.scheduleDlq).add('Lifecycle', 'persistent');

    const collectorLogGroup = new logs.LogGroup(this, 'WeatherWindowCollectorLogs', {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    Tags.of(collectorLogGroup).add('Service', 'data-ingestion');
    Tags.of(collectorLogGroup).add('Component', 'weather-collector');
    Tags.of(collectorLogGroup).add('Lifecycle', 'persistent');
    this.collectorFunction = new lambda.DockerImageFunction(this, 'WeatherWindowCollector', {
      architecture: lambda.Architecture.ARM_64,
      description: 'Collects the fixed historical observation and forecast window into S3',
      code: lambda.DockerImageCode.fromImageAsset(
        path.join(__dirname, '../../../services/data-ingestion'),
        {
          target: 'runtime',
          platform: ecrAssets.Platform.LINUX_ARM64,
          cmd: ['data_ingestion.weather.window_collector.handler'],
        },
      ),
      timeout: Duration.seconds(60),
      memorySize: 256,
      logGroup: collectorLogGroup,
      environment: {
        DATA_BUCKET: this.dataBucket.bucketName,
        TARGET_REFERENCE_TIME: props.targetReferenceTime,
        TARGET_LATITUDE: String(props.targetLatitude),
        TARGET_LONGITUDE: String(props.targetLongitude),
      },
      deadLetterQueue: this.processingDlq,
      retryAttempts: 0,
    });
    this.dataBucket.grantPut(this.collectorFunction, 'raw/open-meteo/weather-window/*');
    this.dataBucket.grantPut(this.collectorFunction, 'manifests/data-ingestion/*');
    Tags.of(this.collectorFunction).add('Service', 'data-ingestion');
    Tags.of(this.collectorFunction).add('Component', 'weather-collector');
    Tags.of(this.collectorFunction).add('Lifecycle', 'on-demand');

    const loaderSecurityGroup = new ec2.SecurityGroup(this, 'WeatherLoaderSecurityGroup', {
      vpc,
      allowAllOutbound: true,
      description: 'Security group for the S3 to PostgreSQL weather loader',
    });
    Tags.of(loaderSecurityGroup).add('Service', 'data-processing');
    Tags.of(loaderSecurityGroup).add('Component', 'weather-loader');
    Tags.of(loaderSecurityGroup).add('Lifecycle', 'runtime');
    const loaderLogGroup = new logs.LogGroup(this, 'WeatherWindowLoaderLogs', {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    Tags.of(loaderLogGroup).add('Service', 'data-processing');
    Tags.of(loaderLogGroup).add('Component', 'weather-loader');
    Tags.of(loaderLogGroup).add('Lifecycle', 'persistent');
    this.loaderFunction = new lambda.DockerImageFunction(this, 'WeatherWindowLoader', {
      architecture: lambda.Architecture.ARM_64,
      description: 'Normalizes the S3 weather window and upserts seven hourly rows into PostgreSQL',
      code: lambda.DockerImageCode.fromImageAsset(
        path.join(__dirname, '../../../services/data-processing'),
        {
          target: 'lambda-loader',
          platform: ecrAssets.Platform.LINUX_ARM64,
        },
      ),
      timeout: Duration.minutes(2),
      memorySize: 512,
      logGroup: loaderLogGroup,
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [loaderSecurityGroup],
      environment: {
        DATABASE_NAME: 'yukisaki',
        DATABASE_SECRET_ARN: this.database.secret!.secretArn,
        TARGET_REFERENCE_TIME: props.targetReferenceTime,
      },
      deadLetterQueue: this.processingDlq,
      retryAttempts: 2,
    });
    this.database.connections.allowDefaultPortFrom(loaderSecurityGroup);
    this.database.secret!.grantRead(this.loaderFunction);
    this.dataBucket.grantRead(this.loaderFunction, 'raw/open-meteo/weather-window/*');
    this.dataBucket.grantPut(this.loaderFunction, 'normalized/open-meteo/weather-window/*');
    this.dataBucket.grantPut(this.loaderFunction, 'manifests/data-processing/*');
    this.dataBucket.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new s3n.LambdaDestination(this.loaderFunction),
      { prefix: 'raw/open-meteo/weather-window/', suffix: '/response.json' },
    );
    Tags.of(this.loaderFunction).add('Service', 'data-processing');
    Tags.of(this.loaderFunction).add('Component', 'weather-loader');
    Tags.of(this.loaderFunction).add('Lifecycle', 'runtime');

    this.collectionSchedule = new events.Rule(this, 'WeatherCollectionSchedule', {
      description: 'Invokes the fixed Open-Meteo weather collector during development or demos',
      enabled: props.scheduleEnabled,
      schedule: events.Schedule.rate(Duration.hours(props.scheduleHours)),
    });
    this.collectionSchedule.addTarget(new eventTargets.LambdaFunction(this.collectorFunction, {
      deadLetterQueue: this.scheduleDlq,
      retryAttempts: 0,
      maxEventAge: Duration.hours(1),
      event: events.RuleTargetInput.fromObject({
        trigger: 'eventbridge',
        referenceTime: props.targetReferenceTime,
      }),
    }));
    Tags.of(this.collectionSchedule).add('Service', 'data-ingestion');
    Tags.of(this.collectionSchedule).add('Component', 'weather-collector');
    Tags.of(this.collectionSchedule).add('Lifecycle', 'runtime');

    this.createMonitoring();

    new CfnOutput(this, 'DataBucketName', { value: this.dataBucket.bucketName });
    new CfnOutput(this, 'CollectorFunctionName', { value: this.collectorFunction.functionName });
    new CfnOutput(this, 'LoaderFunctionName', { value: this.loaderFunction.functionName });
    new CfnOutput(this, 'DatabaseEndpoint', { value: this.database.dbInstanceEndpointAddress });
    new CfnOutput(this, 'DatabaseIdentifier', { value: this.database.instanceIdentifier });
    new CfnOutput(this, 'DatabaseSecretArn', { value: this.database.secret!.secretArn });
    new CfnOutput(this, 'WeatherScheduleName', { value: this.collectionSchedule.ruleName });
    new CfnOutput(this, 'WeatherScheduleDlqUrl', { value: this.scheduleDlq.queueUrl });
    new CfnOutput(this, 'ProcessingDlqUrl', { value: this.processingDlq.queueUrl });
  }

  private createMonitoring(): void {
    const collectorErrors = this.collectorFunction.metricErrors({
      period: Duration.minutes(5),
      statistic: 'sum',
    });
    const loaderErrors = this.loaderFunction.metricErrors({
      period: Duration.minutes(5),
      statistic: 'sum',
    });
    new cloudwatch.Alarm(this, 'CollectorErrorsAlarm', {
      metric: collectorErrors,
      threshold: 1,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    new cloudwatch.Alarm(this, 'LoaderErrorsAlarm', {
      metric: loaderErrors,
      threshold: 1,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    new cloudwatch.Alarm(this, 'ProcessingDlqMessagesAlarm', {
      metric: this.processingDlq.metricApproximateNumberOfMessagesVisible({
        period: Duration.minutes(5),
        statistic: 'max',
      }),
      threshold: 1,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    new cloudwatch.Alarm(this, 'WeatherScheduleDlqMessagesAlarm', {
      metric: this.scheduleDlq.metricApproximateNumberOfMessagesVisible({
        period: Duration.minutes(5),
        statistic: 'max',
      }),
      threshold: 1,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    const dashboard = new cloudwatch.Dashboard(this, 'WeatherPipelineDashboard');
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Weather Lambda errors',
        left: [collectorErrors, loaderErrors],
      }),
      new cloudwatch.GraphWidget({
        title: 'Weather Lambda duration',
        left: [
          this.collectorFunction.metricDuration({ statistic: 'p95' }),
          this.loaderFunction.metricDuration({ statistic: 'p95' }),
        ],
      }),
      new cloudwatch.GraphWidget({
        title: 'PostgreSQL connections and CPU',
        left: [this.database.metricDatabaseConnections(), this.database.metricCPUUtilization()],
      }),
    );
  }
}
