import * as path from 'path';
import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { WebStack } from '../lib/web-stack';

describe('WebStack', () => {
  const app = new App();
  const stack = new WebStack(app, 'WebTestStack', {
    environment: 'test',
    apiEndpoint: 'https://api.example.com',
    webSourcePath: path.join(__dirname, '../../../services/web/public'),
    bundleWebApp: false,
  });
  const template = Template.fromStack(stack);

  test('creates a private retained website bucket', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      BucketEncryption: {
        ServerSideEncryptionConfiguration: [{
          ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' },
        }],
      },
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
      VersioningConfiguration: { Status: 'Enabled' },
    });
    template.hasResource('AWS::S3::Bucket', { DeletionPolicy: 'Retain' });
  });

  test('creates a disabled CloudFront distribution with SPA and API routing', () => {
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        Enabled: false,
        DefaultRootObject: 'index.html',
        CacheBehaviors: Match.arrayWith([
          Match.objectLike({ PathPattern: 'v1/road-segments' }),
          Match.objectLike({ PathPattern: 'v1/road-segments/*' }),
          Match.objectLike({ PathPattern: 'v1/map/snapshot' }),
          Match.objectLike({ PathPattern: 'v1/*' }),
          Match.objectLike({ PathPattern: 'healthz' }),
        ]),
        CustomErrorResponses: Match.arrayWith([
          Match.objectLike({ ErrorCode: 403, ResponseCode: 200, ResponsePagePath: '/index.html' }),
          Match.objectLike({ ErrorCode: 404, ResponseCode: 200, ResponsePagePath: '/index.html' }),
        ]),
      }),
    });
    template.resourceCountIs('Custom::CDKBucketDeployment', 1);
  });

  test('caches public map reads by all query-string parameters', () => {
    template.hasResourceProperties('AWS::CloudFront::CachePolicy', {
      CachePolicyConfig: Match.objectLike({
        DefaultTTL: 3,
        MinTTL: 1,
        MaxTTL: 10,
        ParametersInCacheKeyAndForwardedToOrigin: Match.objectLike({
          QueryStringsConfig: { QueryStringBehavior: 'all' },
          CookiesConfig: { CookieBehavior: 'none' },
        }),
      }),
    });
  });

  test('maps configured custom domains to CloudFront with IPv4 and IPv6 aliases', () => {
    const customDomainStack = new WebStack(new App(), 'WebCustomDomainTestStack', {
      environment: 'test',
      apiEndpoint: 'https://api.example.com',
      webSourcePath: path.join(__dirname, '../../../services/web/public'),
      bundleWebApp: false,
      customDomain: {
        domainNames: ['example.com', 'www.example.com'],
        hostedZoneId: 'Z1234567890',
        hostedZoneName: 'example.com',
        certificateArn: 'arn:aws:acm:us-east-1:111111111111:certificate/test',
      },
    });
    const customDomainTemplate = Template.fromStack(customDomainStack);

    customDomainTemplate.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        Aliases: ['example.com', 'www.example.com'],
        ViewerCertificate: Match.objectLike({
          AcmCertificateArn: 'arn:aws:acm:us-east-1:111111111111:certificate/test',
          SslSupportMethod: 'sni-only',
          MinimumProtocolVersion: 'TLSv1.2_2021',
        }),
      }),
    });
    customDomainTemplate.resourceCountIs('AWS::Route53::RecordSet', 4);
    for (const [name, type] of [
      ['example.com.', 'A'],
      ['example.com.', 'AAAA'],
      ['www.example.com.', 'A'],
      ['www.example.com.', 'AAAA'],
    ]) {
      customDomainTemplate.hasResourceProperties('AWS::Route53::RecordSet', {
        Name: name,
        Type: type,
        AliasTarget: Match.objectLike({
          DNSName: { 'Fn::GetAtt': [Match.anyValue(), 'DomainName'] },
          HostedZoneId: Match.anyValue(),
        }),
      });
    }
  });
});
