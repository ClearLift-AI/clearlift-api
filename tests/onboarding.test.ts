/**
 * Onboarding Service Tests
 *
 * Tests for tag-only user onboarding fixes:
 * - completeStep auto-creates record when missing
 * - isOnboardingComplete uses current_step as authority
 * - incrementServicesConnected auto-advances steps
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OnboardingService } from '../src/services/onboarding';

function createMockDb() {
  const mockDb: any = {
    prepare: vi.fn().mockReturnThis(),
    bind: vi.fn().mockReturnThis(),
    first: vi.fn(),
    all: vi.fn(),
    run: vi.fn().mockResolvedValue({ success: true }),
  };
  return mockDb;
}

describe('OnboardingService', () => {
  let mockDb: any;
  let service: OnboardingService;

  beforeEach(() => {
    vi.clearAllMocks();
    mockDb = createMockDb();
    service = new OnboardingService(mockDb);
  });

  describe('completeStep', () => {
    it('should auto-create record when none exists and organizationId provided', async () => {
      // First getProgress call returns null (no existing record)
      // After startOnboarding insert, getProgress returns the new record
      // After completeStep update, getProgress returns updated record
      mockDb.first
        .mockResolvedValueOnce(null) // completeStep -> getProgress (no record)
        .mockResolvedValueOnce(null) // startOnboarding -> getProgress (check existing)
        .mockResolvedValueOnce({     // startOnboarding -> getProgress (return created)
          user_id: 'user-1',
          organization_id: 'org-1',
          current_step: 'welcome',
          steps_completed: '["welcome"]',
          services_connected: 0,
          first_sync_completed: false,
          has_verified_tag: false,
          has_defined_goal: false,
          verified_domains_count: 0,
          goals_count: 0,
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:00:00Z',
          completed_at: null,
        })
        .mockResolvedValueOnce({     // completeStep -> final getProgress
          user_id: 'user-1',
          organization_id: 'org-1',
          current_step: 'connect_services',
          steps_completed: '["welcome"]',
          services_connected: 0,
          first_sync_completed: false,
          has_verified_tag: false,
          has_defined_goal: false,
          verified_domains_count: 0,
          goals_count: 0,
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:00:00Z',
          completed_at: null,
        });

      const result = await service.completeStep('user-1', 'welcome', 'org-1');

      expect(result).toBeDefined();
      expect(result.user_id).toBe('user-1');
      // Should have called INSERT for startOnboarding
      expect(mockDb.prepare).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO onboarding_progress')
      );
    });

    it('should throw when no record AND no organizationId', async () => {
      mockDb.first.mockResolvedValueOnce(null);

      await expect(service.completeStep('user-1', 'welcome')).rejects.toThrow(
        'Onboarding not started and no organization_id provided'
      );
    });

    it('should be idempotent - completing same step twice does not break', async () => {
      const progressRecord = {
        user_id: 'user-1',
        organization_id: 'org-1',
        current_step: 'connect_services',
        steps_completed: '["welcome"]',
        services_connected: 1,
        first_sync_completed: false,
        has_verified_tag: false,
        has_defined_goal: false,
        verified_domains_count: 0,
        goals_count: 0,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        completed_at: null,
      };

      // First call
      mockDb.first.mockResolvedValueOnce(progressRecord);
      mockDb.first.mockResolvedValueOnce({
        ...progressRecord,
        current_step: 'first_sync',
        steps_completed: '["welcome","connect_services"]',
      });

      const result1 = await service.completeStep('user-1', 'connect_services');
      expect(result1.current_step).toBe('first_sync');

      // Second call - same step again
      mockDb.first.mockResolvedValueOnce({
        ...progressRecord,
        current_step: 'first_sync',
        steps_completed: '["welcome","connect_services"]',
      });
      mockDb.first.mockResolvedValueOnce({
        ...progressRecord,
        current_step: 'completed',
        steps_completed: '["welcome","connect_services"]',
      });

      // Should not throw
      const result2 = await service.completeStep('user-1', 'connect_services');
      expect(result2).toBeDefined();
    });
  });

  describe('isOnboardingComplete', () => {
    it('should return true when current_step === completed', async () => {
      mockDb.first.mockResolvedValueOnce({
        user_id: 'user-1',
        organization_id: 'org-1',
        current_step: 'completed',
        steps_completed: '["welcome","connect_services","first_sync","completed"]',
        services_connected: 1,
        first_sync_completed: true,
        has_verified_tag: false,
        has_defined_goal: false,
        verified_domains_count: 0,
        goals_count: 0,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        completed_at: '2026-01-01T00:00:00Z',
      });

      const result = await service.isOnboardingComplete('user-1');
      expect(result).toBe(true);
    });

    it('should return false when current_step !== completed regardless of booleans', async () => {
      mockDb.first.mockResolvedValueOnce({
        user_id: 'user-1',
        organization_id: 'org-1',
        current_step: 'first_sync',
        steps_completed: '["welcome","connect_services"]',
        services_connected: 3,
        first_sync_completed: false,
        has_verified_tag: true,
        has_defined_goal: true,
        verified_domains_count: 2,
        goals_count: 1,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        completed_at: null,
      });

      const result = await service.isOnboardingComplete('user-1');
      expect(result).toBe(false);
    });

    it('should return false when no progress record exists', async () => {
      mockDb.first.mockResolvedValueOnce(null);

      const result = await service.isOnboardingComplete('user-1');
      expect(result).toBe(false);
    });
  });

  describe('incrementServicesConnected', () => {
    it('should auto-advance from connect_services to first_sync when services >= 1', async () => {
      // incrementServicesConnected calls UPDATE, then getProgress
      mockDb.first.mockResolvedValueOnce({
        user_id: 'user-1',
        organization_id: 'org-1',
        current_step: 'connect_services',
        steps_completed: '["welcome"]',
        services_connected: 1,
        first_sync_completed: false,
        has_verified_tag: false,
        has_defined_goal: false,
        verified_domains_count: 0,
        goals_count: 0,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        completed_at: null,
      });

      // completeStep -> getProgress
      mockDb.first.mockResolvedValueOnce({
        user_id: 'user-1',
        organization_id: 'org-1',
        current_step: 'connect_services',
        steps_completed: '["welcome"]',
        services_connected: 1,
        first_sync_completed: false,
        has_verified_tag: false,
        has_defined_goal: false,
        verified_domains_count: 0,
        goals_count: 0,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        completed_at: null,
      });

      // completeStep -> final getProgress
      mockDb.first.mockResolvedValueOnce({
        user_id: 'user-1',
        organization_id: 'org-1',
        current_step: 'first_sync',
        steps_completed: '["welcome","connect_services"]',
        services_connected: 1,
        first_sync_completed: false,
        has_verified_tag: false,
        has_defined_goal: false,
        verified_domains_count: 0,
        goals_count: 0,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        completed_at: null,
      });

      await service.incrementServicesConnected('user-1');

      // Should have called UPDATE for services_connected increment
      expect(mockDb.prepare).toHaveBeenCalledWith(
        expect.stringContaining('services_connected = services_connected + 1')
      );
      // Should have called completeStep (which calls UPDATE for current_step)
      expect(mockDb.prepare).toHaveBeenCalledWith(
        expect.stringContaining('SET current_step')
      );
    });
  });
});
