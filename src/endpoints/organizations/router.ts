import { ListOrganizations } from "./list";
import { CreateOrganization } from "./create";
import { SwitchOrganization } from "./switch";

// Export individual classes for registration
export const organizationsEndpoints = [
  ListOrganizations,
  CreateOrganization,
  SwitchOrganization
];