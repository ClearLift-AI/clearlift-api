/// <reference types="@cloudflare/workers-types" />

declare global {
  interface Env {
    // D1 Databases
    DB: D1Database;
    AD_DATA: D1Database;
    
    // R2 Bucket
    R2_EVENTS: R2Bucket;
    
    // Container bindings
    DUCKLAKE: any; // Container binding for DuckLake
    
    // Environment variables for R2 Data Catalog
    DATALAKE_CATALOG_URI: string;
    DATALAKE_WAREHOUSE_NAME: string;
    R2_S3_API_URL: string;
    R2_BUCKET: string;
    
    // R2 secrets (stored in Cloudflare secret store)
    R2_READ_ONLY_ACCESS_ID?: string;
    R2_READ_ONLY_ACCESS_SECRET?: string;
    R2_READ_ONLY_TOKEN?: string;
    
    R2_WRITE_ACCESS_ID?: string;
    R2_WRITE_ACCESS_SECRET?: string;
    R2_WRITE_TOKEN?: string;
    
    // Debug token for accessing debug endpoints
    DEBUG_TOKEN?: string;
    
    // Google OAuth credentials
    GOOGLE_CLIENT_ID?: string;
    GOOGLE_CLIENT_SECRET?: string;
    GOOGLE_ADS_DEVELOPER_TOKEN?: string;
  }
}

export {};