import * as path from 'path';
import {
  CfnOutput,
  DockerImage,
  Duration,
  Fn,
  RemovalPolicy,
  Stack,
  StackProps,
  Tags,
} from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import { Construct } from 'constructs';

export interface WebStackProps extends StackProps {
  readonly environment: string;
  readonly apiEndpoint: string;
  readonly webSourcePath?: string;
  readonly bundleWebApp?: boolean;
}

/** Private S3 and CloudFront delivery for the React frontend. */
export class WebStack extends Stack {
  public readonly distribution: cloudfront.Distribution;
  public readonly websiteBucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: WebStackProps) {
    super(scope, id, props);

    Tags.of(this).add('Project', 'yukisaki-center');
    Tags.of(this).add('Environment', props.environment);
    Tags.of(this).add('Component', 'web');
    Tags.of(this).add('ManagedBy', 'aws-cdk');

    this.websiteBucket = new s3.Bucket(this, 'WebsiteBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    Tags.of(this.websiteBucket).add('Lifecycle', 'persistent');
    Tags.of(this.websiteBucket).add('Service', 'web');

    const apiDomainName = Fn.select(2, Fn.split('/', props.apiEndpoint));
    const apiOrigin = new origins.HttpOrigin(apiDomainName, {
      protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
    });
    const apiBehavior: cloudfront.BehaviorOptions = {
      origin: apiOrigin,
      allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
      cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD_OPTIONS,
      cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
      originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      compress: true,
    };

    this.distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: `Yukisaki Web (${props.environment})`,
      enabled: false,
      defaultRootObject: 'index.html',
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(this.websiteBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        compress: true,
      },
      additionalBehaviors: {
        'v1/*': apiBehavior,
        healthz: apiBehavior,
      },
      errorResponses: [403, 404].map((httpStatus) => ({
        httpStatus,
        responseHttpStatus: 200,
        responsePagePath: '/index.html',
        ttl: Duration.seconds(0),
      })),
    });
    Tags.of(this.distribution).add('Lifecycle', 'runtime');
    Tags.of(this.distribution).add('Service', 'web');

    const webSourcePath = props.webSourcePath
      ?? path.join(__dirname, '../../../services/web');
    const source = props.bundleWebApp === false
      ? s3deploy.Source.asset(webSourcePath)
      : s3deploy.Source.asset(webSourcePath, {
        exclude: ['node_modules', 'dist', 'legacy-static'],
        bundling: {
          image: DockerImage.fromRegistry('node:22-alpine'),
          command: [
            'sh',
            '-c',
            [
              'cp -R /asset-input/. /tmp/yukisaki-web',
              'cd /tmp/yukisaki-web',
              'HOME=/tmp COREPACK_HOME=/tmp/corepack corepack pnpm install --frozen-lockfile',
              'HOME=/tmp COREPACK_HOME=/tmp/corepack VITE_DATA_MODE=api VITE_YUKISAKI_API_URL= VITE_ENABLE_MOCK_FALLBACK=true corepack pnpm build',
              'cp -R dist/. /asset-output/',
            ].join(' && '),
          ],
        },
      });

    new s3deploy.BucketDeployment(this, 'DeployWebsite', {
      sources: [source],
      destinationBucket: this.websiteBucket,
      distribution: this.distribution,
      distributionPaths: ['/*'],
      prune: true,
    });

    new CfnOutput(this, 'WebBucketName', { value: this.websiteBucket.bucketName });
    new CfnOutput(this, 'WebDistributionId', {
      value: this.distribution.distributionId,
    });
    new CfnOutput(this, 'WebUrl', {
      value: `https://${this.distribution.distributionDomainName}`,
    });
  }
}
