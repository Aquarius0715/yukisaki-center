import * as path from 'path';
import {
  AssetHashType,
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
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53Targets from 'aws-cdk-lib/aws-route53-targets';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import { Construct } from 'constructs';

export interface WebCustomDomainConfig {
  readonly domainNames: string[];
  readonly hostedZoneId: string;
  readonly hostedZoneName: string;
  readonly certificateArn: string;
}

export interface WebStackProps extends StackProps {
  readonly environment: string;
  readonly apiEndpoint: string;
  readonly mapKitToken?: string;
  readonly webSourcePath?: string;
  readonly bundleWebApp?: boolean;
  readonly customDomain?: WebCustomDomainConfig;
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
    const mapApiCachePolicy = new cloudfront.CachePolicy(this, 'MapApiCachePolicy', {
      comment: `Shared map API cache (${props.environment})`,
      // Short on purpose: drivability-score colors should reach the map
      // within seconds of a GPS-triggered rescore, not up to 90s later.
      defaultTtl: Duration.seconds(3),
      minTtl: Duration.seconds(1),
      maxTtl: Duration.seconds(10),
      queryStringBehavior: cloudfront.CacheQueryStringBehavior.all(),
      cookieBehavior: cloudfront.CacheCookieBehavior.none(),
      headerBehavior: cloudfront.CacheHeaderBehavior.none(),
      enableAcceptEncodingBrotli: true,
      enableAcceptEncodingGzip: true,
    });
    const cachedMapApiBehavior: cloudfront.BehaviorOptions = {
      ...apiBehavior,
      allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
      cachePolicy: mapApiCachePolicy,
    };
    const customDomainNames = props.customDomain?.domainNames ?? [];
    if (props.customDomain && customDomainNames.length === 0) {
      throw new Error('customDomain.domainNames must contain at least one domain name');
    }
    const certificate = props.customDomain
      ? acm.Certificate.fromCertificateArn(
        this,
        'CustomDomainCertificate',
        props.customDomain.certificateArn,
      )
      : undefined;

    this.distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: `Yukisaki Web (${props.environment})`,
      enabled: false,
      defaultRootObject: 'index.html',
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      certificate,
      domainNames: customDomainNames.length > 0 ? customDomainNames : undefined,
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(this.websiteBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        compress: true,
      },
      additionalBehaviors: {
        'v1/road-segments': cachedMapApiBehavior,
        'v1/road-segments/*': cachedMapApiBehavior,
        'v1/map/snapshot': cachedMapApiBehavior,
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

    if (props.customDomain) {
      const hostedZone = route53.HostedZone.fromHostedZoneAttributes(
        this,
        'CustomDomainHostedZone',
        {
          hostedZoneId: props.customDomain.hostedZoneId,
          zoneName: props.customDomain.hostedZoneName,
        },
      );
      const zoneSuffix = `.${props.customDomain.hostedZoneName}`;
      customDomainNames.forEach((domainName, index) => {
        let recordName: string | undefined;
        if (domainName === props.customDomain!.hostedZoneName) {
          recordName = undefined;
        } else if (domainName.endsWith(zoneSuffix)) {
          recordName = domainName.slice(0, -zoneSuffix.length);
        } else {
          throw new Error(
            `Custom domain ${domainName} is outside hosted zone ${props.customDomain!.hostedZoneName}`,
          );
        }
        const target = route53.RecordTarget.fromAlias(
          new route53Targets.CloudFrontTarget(this.distribution),
        );
        new route53.ARecord(this, `CustomDomainIpv4Record${index + 1}`, {
          zone: hostedZone,
          recordName,
          target,
        });
        new route53.AaaaRecord(this, `CustomDomainIpv6Record${index + 1}`, {
          zone: hostedZone,
          recordName,
          target,
        });
      });
    }

    const webSourcePath = props.webSourcePath
      ?? path.join(__dirname, '../../../services/web');
    if (props.bundleWebApp !== false && !props.mapKitToken) {
      throw new Error(
        'VITE_MAPKIT_TOKEN is required when bundling the Web app. Use the CDK npm scripts so the token is loaded from Secrets Manager.',
      );
    }
    const source = props.bundleWebApp === false
      ? s3deploy.Source.asset(webSourcePath)
      : s3deploy.Source.asset(webSourcePath, {
        // The token is supplied only while bundling, so hash the output to ensure
        // a token rotation produces and deploys a new website asset.
        assetHashType: AssetHashType.OUTPUT,
        exclude: ['node_modules', 'dist', 'legacy-static'],
        bundling: {
          image: DockerImage.fromRegistry('node:22-alpine'),
          environment: {
            VITE_MAPKIT_TOKEN: props.mapKitToken!,
          },
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
    if (customDomainNames.length > 0) {
      new CfnOutput(this, 'CustomWebUrl', {
        value: `https://${customDomainNames[0]}`,
      });
    }
  }
}
