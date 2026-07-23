import * as path from 'path';
import {
  CfnOutput,
  Duration,
  RemovalPolicy,
  Stack,
  StackProps,
  Tags,
} from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigatewayv2';
import * as integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecrAssets from 'aws-cdk-lib/aws-ecr-assets';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

export interface ApiStackProps extends StackProps {
  readonly environment: string;
  readonly databaseVpc: ec2.IVpc;
  readonly database: rds.IDatabaseInstance;
  readonly databaseSecret: secretsmanager.ISecret;
  readonly databaseName: string;
}

/** Public read-only map API backed by the unified PostgreSQL serving projection. */
export class ApiStack extends Stack {
  public readonly apiFunction: lambda.DockerImageFunction;
  public readonly httpApi: apigateway.HttpApi;

  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);

    Tags.of(this).add('Project', 'yukisaki-center');
    Tags.of(this).add('Environment', props.environment);
    Tags.of(this).add('Component', 'public-map-api');
    Tags.of(this).add('ManagedBy', 'aws-cdk');

    const apiSecurityGroup = new ec2.SecurityGroup(this, 'ApiSecurityGroup', {
      vpc: props.databaseVpc,
      allowAllOutbound: true,
      description: 'PostgreSQL access for the read-only map API Lambda',
    });
    new ec2.CfnSecurityGroupIngress(this, 'UnifiedDatabaseIngressFromApi', {
      groupId: props.database.connections.securityGroups[0].securityGroupId,
      sourceSecurityGroupId: apiSecurityGroup.securityGroupId,
      ipProtocol: 'tcp',
      fromPort: 5432,
      toPort: 5432,
      description: 'Allow PostgreSQL only from the public API Lambda',
    });

    const logGroup = new logs.LogGroup(this, 'ApiFunctionLogs', {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    this.apiFunction = new lambda.DockerImageFunction(this, 'MapApiFunction', {
      architecture: lambda.Architecture.ARM_64,
      description: 'Returns road, drivability, and simulated snowplow GeoJSON to the frontend',
      code: lambda.DockerImageCode.fromImageAsset(path.join(__dirname, '../../../services/api'), {
        target: 'lambda',
        platform: ecrAssets.Platform.LINUX_ARM64,
      }),
      timeout: Duration.seconds(20),
      memorySize: 1024,
      reservedConcurrentExecutions: 0,
      logGroup,
      vpc: props.databaseVpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [apiSecurityGroup],
      environment: {
        DATABASE_NAME: props.databaseName,
        DATABASE_SECRET_ARN: props.databaseSecret.secretArn,
      },
    });
    props.databaseSecret.grantRead(this.apiFunction);
    Tags.of(this.apiFunction).add('Lifecycle', 'runtime');
    Tags.of(this.apiFunction).add('Service', 'api');

    this.httpApi = new apigateway.HttpApi(this, 'MapHttpApi', {
      apiName: `yukisaki-map-api-${props.environment}`,
      description: 'Yukisaki frontend GeoJSON API',
      corsPreflight: {
        allowOrigins: ['*'],
        allowMethods: [apigateway.CorsHttpMethod.GET, apigateway.CorsHttpMethod.POST],
        allowHeaders: ['content-type'],
        maxAge: Duration.hours(1),
      },
    });
    const integration = new integrations.HttpLambdaIntegration('MapApiIntegration', this.apiFunction);
    for (const route of [
      '/healthz',
      '/v1/road-segments',
      '/v1/road-segments/{id}',
      '/v1/snowplows',
      '/v1/map/snapshot',
    ]) {
      this.httpApi.addRoutes({
        path: route,
        methods: [apigateway.HttpMethod.GET],
        integration,
      });
    }

    new CfnOutput(this, 'ApiFunctionName', { value: this.apiFunction.functionName });
    new CfnOutput(this, 'ApiUrl', { value: this.httpApi.apiEndpoint });
  }
}
