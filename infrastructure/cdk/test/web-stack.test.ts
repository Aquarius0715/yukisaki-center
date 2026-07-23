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
});
