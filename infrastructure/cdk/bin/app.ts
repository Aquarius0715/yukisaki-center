#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { DataPipelineStack } from '../lib/data-pipeline-stack';
import { RoadCollectorStack } from '../lib/road-collector-stack';
import { SnowPipePipelineStack } from '../lib/snow-pipe-pipeline-stack';
import { GpsPipelineStack } from '../lib/gps-pipeline-stack';
import { ApiStack } from '../lib/api-stack';
import { AiAssistantStack } from '../lib/ai-assistant-stack';
import { WebStack } from '../lib/web-stack';
import { RoutePlanningStack } from '../lib/route-planning-stack';

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

const dataPipelineStack = new DataPipelineStack(app, `YukisakiDataPipeline-${environment}`, {
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

const roadCollectorStack = new RoadCollectorStack(app, `YukisakiRoadCollector-${environment}`, {
  environment,
  scheduleEnabled: contextBoolean('roadScheduleEnabled', false),
  scheduleHours: Number(app.node.tryGetContext('roadScheduleHours') ?? 168),
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region,
  },
  description: 'Isolated OpenStreetMap road collection pipeline',
});

const snowPipePipelineStack = new SnowPipePipelineStack(app, `YukisakiSnowPipePipeline-${environment}`, {
  environment,
  targetReferenceTime:
    app.node.tryGetContext('targetReferenceTime') ?? '2026-01-23T12:00:00+09:00',
  roadBucket: roadCollectorStack.dataBucket,
  databaseVpc: dataPipelineStack.databaseVpc,
  database: dataPipelineStack.database,
  databaseSecret: dataPipelineStack.database.secret!,
  databaseName: 'yukisaki',
  manifestRuleEnabled: contextBoolean('snowPipeManifestRuleEnabled', false),
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region,
  },
  description: 'Simulated snow-pipe enrichment loaded into the unified PostgreSQL database',
});

new GpsPipelineStack(app, `YukisakiGpsPipeline-${environment}`, {
  environment,
  targetReferenceTime:
    app.node.tryGetContext('targetReferenceTime') ?? '2026-01-23T12:00:00+09:00',
  targetLatitude: Number(app.node.tryGetContext('targetLatitude') ?? 37.442762),
  targetLongitude: Number(app.node.tryGetContext('targetLongitude') ?? 138.790865),
  simulatorEnabled: contextBoolean('gpsSimulatorEnabled', false),
  emitIntervalSeconds: Number(app.node.tryGetContext('gpsEmitIntervalSeconds') ?? 5),
  dataBucket: dataPipelineStack.dataBucket,
  roadCuratedBucket: snowPipePipelineStack.dataBucket,
  databaseVpc: dataPipelineStack.databaseVpc,
  database: dataPipelineStack.database,
  databaseSecret: dataPipelineStack.database.secret!,
  databaseName: 'yukisaki',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region,
  },
  description: 'Three simulated snowplows streamed through EventBridge, S3, PostgreSQL, and scoring',
});

const routePlanningStack = new RoutePlanningStack(app, `YukisakiRoutePlanning-${environment}`, {
  environment,
  databaseVpc: dataPipelineStack.databaseVpc,
  database: dataPipelineStack.database,
  databaseSecret: dataPipelineStack.database.secret!,
  databaseName: 'yukisaki',
  targetReferenceTime:
    app.node.tryGetContext('targetReferenceTime') ?? '2026-01-23T12:00:00+09:00',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region,
  },
  description: 'PostGIS and pgRouting route planning with dynamic drivability costs',
});

const apiStack = new ApiStack(app, `YukisakiApi-${environment}`, {
  environment,
  databaseVpc: dataPipelineStack.databaseVpc,
  database: dataPipelineStack.database,
  databaseSecret: dataPipelineStack.database.secret!,
  databaseName: 'yukisaki',
  routePlanningFunction: routePlanningStack.routeFunction,
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region,
  },
  description: 'Public GeoJSON API for roads, snowplows, and route planning',
});

new AiAssistantStack(app, `YukisakiAiAssistant-${environment}`, {
  environment,
  httpApi: apiStack.httpApi,
  modelId:
    app.node.tryGetContext('bedrockModelId') ??
    'jp.anthropic.claude-sonnet-4-5-20250929-v1:0',
  guardrailIdentifier: app.node.tryGetContext('bedrockGuardrailIdentifier'),
  guardrailVersion: app.node.tryGetContext('bedrockGuardrailVersion'),
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region,
  },
  description: 'Bedrock route condition extraction and evidence-bound explanations',
});

new WebStack(app, `YukisakiWeb-${environment}`, {
  environment,
  apiEndpoint: apiStack.httpApi.apiEndpoint,
  mapKitToken: process.env.VITE_MAPKIT_TOKEN,
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region,
  },
  description: 'Private S3 and CloudFront delivery for the Yukisaki React frontend',
});
