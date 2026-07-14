#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { DataPipelineStack } from '../lib/data-pipeline-stack';

const app = new cdk.App();
const environment = app.node.tryGetContext('environment') ?? 'dev';
const region = app.node.tryGetContext('region') ?? 'ap-northeast-1';

new DataPipelineStack(app, `YukisakiDataPipeline-${environment}`, {
  environment,
  scheduleMinutes: Number(app.node.tryGetContext('scheduleMinutes') ?? 60),
  roadScheduleHours: Number(app.node.tryGetContext('roadScheduleHours') ?? 168),
  weatherSourceUrl:
    app.node.tryGetContext('weatherSourceUrl') ??
    'https://www.data.jma.go.jp/developer/xml/feed/regular.xml',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region,
  },
  description: 'Yukisaki snow-safe route data collection and normalization pipeline',
});
