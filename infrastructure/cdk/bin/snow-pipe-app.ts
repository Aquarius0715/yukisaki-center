#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { SnowPipePipelineStack } from '../lib/snow-pipe-pipeline-stack';

const app = new cdk.App();
const environment = app.node.tryGetContext('environment') ?? 'dev';
const region = app.node.tryGetContext('region') ?? 'ap-northeast-1';

const contextBoolean = (key: string, defaultValue: boolean): boolean => {
  const value = app.node.tryGetContext(key);
  if (value === undefined) {
    return defaultValue;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  return String(value).trim().toLowerCase() === 'true';
};

const requiredString = (key: string): string => {
  const value = app.node.tryGetContext(key);
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`CDK context ${key} is required for the standalone Snow Pipe stack`);
  }
  return value;
};

new SnowPipePipelineStack(app, `YukisakiSnowPipePipeline-${environment}`, {
  environment,
  targetReferenceTime:
    app.node.tryGetContext('targetReferenceTime') ?? '2026-01-23T12:00:00+09:00',
  roadBucketName: requiredString('snowPipeRoadBucketName'),
  manifestRuleEnabled: contextBoolean('snowPipeManifestRuleEnabled', false),
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region,
  },
  description: 'Standalone simulated snow-pipe enrichment and PostgreSQL loading pipeline',
});
