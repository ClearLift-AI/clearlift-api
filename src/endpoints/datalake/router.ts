import { CreateTable, ListTables, GetTableSchema, DropTable } from "./tables";
import { WriteData, BatchWriteData, QueryData } from "./data";
import { InitializeDatalake, GetStandardSchemas } from "./init";
import { SyncCampaignsToDatalake, SyncEventsToDatalake, GetSyncStatus } from "./sync";

// Export individual classes for registration
export const datalakeEndpoints = [
  CreateTable,
  ListTables,
  GetTableSchema,
  DropTable,
  WriteData,
  BatchWriteData,
  QueryData,
  InitializeDatalake,
  GetStandardSchemas,
  SyncCampaignsToDatalake,
  SyncEventsToDatalake,
  GetSyncStatus
];