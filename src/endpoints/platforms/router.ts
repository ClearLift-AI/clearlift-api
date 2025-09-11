import { ListPlatforms } from "./list";
import { SyncPlatform } from "./sync";
import { GetSyncHistory } from "./syncHistory";

// Export individual classes for registration
export const platformsEndpoints = [
  ListPlatforms,
  SyncPlatform,
  GetSyncHistory
];