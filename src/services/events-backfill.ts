/**
 * Events Backfill Service
 *
 * Handles domain claiming and backfilling in the events schema.
 * When a user links a tracking domain, this service:
 * 1. Claims the domain in events.domain_claims
 * 2. Returns the count of matching historical domain_xxx events
 *
 * The actual event resolution is handled by the org_events view dynamically,
 * so no expensive UPDATE operations are needed.
 */

import { SupabaseClient } from './supabase';

export interface BackfillResult {
  events_updated: number;
  claim_id: string;
}

export interface DomainAvailability {
  available: boolean;
  claimed_by: string | null;
  claimed_at: string | null;
}

export interface BackfillStatus {
  status: 'pending' | 'syncing' | 'completed' | 'failed';
  events_count: number;
  completed_at: string | null;
}

export class EventsBackfillService {
  constructor(private supabase: SupabaseClient) {}

  /**
   * Claim a domain for an organization and count matching historical events.
   * This creates or updates a record in events.domain_claims.
   * The org_events view will then resolve domain_xxx events to this org.
   *
   * @param domain - The domain to claim (e.g., "rockbot.com")
   * @param orgTag - The org_tag to assign events to (e.g., "acme")
   * @returns BackfillResult with count of matching events and claim ID
   * @throws Error if domain is already claimed by another org
   */
  async claimDomain(domain: string, orgTag: string): Promise<BackfillResult> {
    try {
      const result = await this.supabase.rpcWithSchema<BackfillResult[]>(
        'backfill_domain_events',
        {
          p_domain: domain,
          p_org_tag: orgTag
        },
        'events'
      );

      // RPC returns array with single row
      if (result && result.length > 0) {
        return {
          events_updated: Number(result[0].events_updated) || 0,
          claim_id: result[0].claim_id || ''
        };
      }

      return { events_updated: 0, claim_id: '' };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';

      // Check for domain already claimed error
      if (message.includes('already claimed') || message.includes('unique_violation')) {
        throw new Error(`Domain "${domain}" is already claimed by another organization`);
      }

      throw new Error(`Failed to claim domain: ${message}`);
    }
  }

  /**
   * Release a domain claim for an organization.
   * Events will no longer be associated with this org.
   * The domain can then be claimed by another org.
   *
   * @param domain - The domain to release (e.g., "rockbot.com")
   * @param orgTag - The org_tag that owns the claim
   * @returns true if claim was released, false if no active claim found
   */
  async releaseDomain(domain: string, orgTag: string): Promise<boolean> {
    try {
      const result = await this.supabase.rpcWithSchema<boolean>(
        'release_domain_claim',
        {
          p_domain: domain,
          p_org_tag: orgTag
        },
        'events'
      );

      return result === true;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      throw new Error(`Failed to release domain claim: ${message}`);
    }
  }

  /**
   * Check if a domain is available for claiming.
   *
   * @param domain - The domain to check
   * @returns Availability info including who owns it if claimed
   */
  async checkDomainAvailability(domain: string): Promise<DomainAvailability> {
    try {
      const result = await this.supabase.rpcWithSchema<DomainAvailability[]>(
        'is_domain_available',
        { p_domain: domain },
        'events'
      );

      if (result && result.length > 0) {
        return {
          available: result[0].available,
          claimed_by: result[0].claimed_by,
          claimed_at: result[0].claimed_at
        };
      }

      return { available: true, claimed_by: null, claimed_at: null };
    } catch (error) {
      // If the function doesn't exist yet, assume available
      console.warn('is_domain_available function not found, assuming available');
      return { available: true, claimed_by: null, claimed_at: null };
    }
  }

  /**
   * Get the backfill status for a domain.
   * Returns the sync status and event count from domain_claims.
   *
   * @param domain - The domain to check status for
   * @returns BackfillStatus or null if domain not claimed
   */
  async getDomainBackfillStatus(domain: string): Promise<BackfillStatus | null> {
    try {
      // Use PostgREST query format: table?column=eq.value&select=columns
      const endpoint = `domain_claims?domain=eq.${encodeURIComponent(domain)}&released_at=is.null&select=backfill_started_at,backfill_completed_at,backfill_events_count&limit=1`;

      const result = await this.supabase.queryWithSchema<{
        backfill_started_at: string | null;
        backfill_completed_at: string | null;
        backfill_events_count: number | null;
      }[]>(endpoint, 'events', { method: 'GET' });

      if (!result || result.length === 0) {
        return null;
      }

      const claim = result[0];

      // Determine status based on timestamps
      let status: BackfillStatus['status'];
      if (claim.backfill_completed_at) {
        status = 'completed';
      } else if (claim.backfill_started_at) {
        status = 'syncing';
      } else {
        status = 'pending';
      }

      return {
        status,
        events_count: claim.backfill_events_count || 0,
        completed_at: claim.backfill_completed_at
      };
    } catch (error) {
      console.error('Failed to get domain backfill status:', error);
      return null;
    }
  }

  /**
   * Trigger a resync for a domain (re-run the backfill).
   * This recounts events and updates the claim.
   *
   * @param domain - The domain to resync
   * @param orgTag - The org_tag that owns the claim
   * @returns BackfillResult with updated event count
   */
  async resyncDomain(domain: string, orgTag: string): Promise<BackfillResult> {
    try {
      // Mark as syncing first using PostgREST PATCH format
      const filter = `domain=eq.${encodeURIComponent(domain)}&claimed_org_tag=eq.${encodeURIComponent(orgTag)}`;
      await this.supabase.updateWithSchema(
        'domain_claims',
        {
          backfill_started_at: new Date().toISOString(),
          backfill_completed_at: null,
          updated_at: new Date().toISOString()
        },
        filter,
        'events'
      );

      // Re-run the backfill (which will count events and update completed_at)
      return await this.claimDomain(domain, orgTag);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      throw new Error(`Failed to resync domain: ${message}`);
    }
  }
}
