#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { DataPipelineStack } from '../lib/data-pipeline-stack';
import { RoadCollectorStack } from '../lib/road-collector-stack';

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

new DataPipelineStack(app, `YukisakiDataPipeline-${environment}`, {
  environment,
  scheduleEnabled: contextBoolean('weatherScheduleEnabled', false),
  scheduleHours: Number(app.node.tryGetContext('weatherScheduleHours') ?? 24),
  targetReferenceTime:
    app.node.tryGetContext('targetReferenceTime') ?? '2026-01-23T12:00:00+09:00',
  targetLatitude: Number(app.node.tryGetContext('targetLatitude') ?? 37.442762),
  targetLongitude: Number(app.node.tryGetContext('targetLongitude') ?? 138.790865),
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region,
  },
  description: 'Yukisaki historical weather window to PostgreSQL pipeline',
});

new RoadCollectorStack(app, `YukisakiRoadCollector-${environment}`, {
  environment,
  scheduleEnabled: contextBoolean('roadScheduleEnabled', false),
  scheduleHours: Number(app.node.tryGetContext('roadScheduleHours') ?? 168),
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region,
  },
  description: 'Isolated OpenStreetMap road collection pipeline',
});
