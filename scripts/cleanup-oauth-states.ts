/**
 * Cleanup script for old/expired OAuth states
 *
 * Run with: npx wrangler dev --local
 * Then call: curl http://localhost:8787/cleanup-oauth-states
 */

export async function cleanupOAuthStates(db: D1Database) {
  const now = new Date();
  const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000).toISOString();

  // Delete OAuth states older than 1 hour
  const result = await db.prepare(`
    DELETE FROM oauth_states
    WHERE created_at < ?
  `).bind(oneHourAgo).run();

  console.log(`Cleaned up ${result.meta.changes} expired OAuth states`);

  return {
    deleted: result.meta.changes,
    cutoff: oneHourAgo
  };
}

export async function cleanupFailedConnections(db: D1Database, organizationId: string) {
  // Find connections with failed sync status and no successful syncs
  const failedConnections = await db.prepare(`
    SELECT pc.id, pc.platform, pc.account_name, pc.created_at
    FROM platform_connections pc
    WHERE pc.organization_id = ?
      AND pc.sync_status = 'failed'
      AND pc.last_synced_at IS NULL
      AND pc.created_at < datetime('now', '-1 hour')
  `).bind(organizationId).all();

  console.log(`Found ${failedConnections.results.length} failed connections to clean up`);

  for (const conn of failedConnections.results) {
    // Delete sync jobs for this connection
    await db.prepare(`DELETE FROM sync_jobs WHERE connection_id = ?`).bind(conn.id).run();

    // Delete the connection
    await db.prepare(`DELETE FROM platform_connections WHERE id = ?`).bind(conn.id).run();

    console.log(`Deleted failed connection: ${conn.platform} - ${conn.account_name}`);
  }

  return {
    deleted: failedConnections.results.length,
    connections: failedConnections.results
  };
}
