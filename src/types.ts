export const REQUIRED_SCOPES = [
  "enrollment:own_enrollment:read",
  "content:toc:read",
  "content:file:read",
] as const;

interface CommonConfig {
  baseUrl: string;
  outputDir: string;
  concurrency: number;
}

export interface OAuthAppConfig extends CommonConfig {
  auth: {
    method: "oauth";
    clientId: string;
    redirectUri: string;
  };
}

export interface BrowserSessionAppConfig extends CommonConfig {
  auth: {
    method: "browser-session";
  };
}

export type AppConfig = OAuthAppConfig | BrowserSessionAppConfig;

export interface OAuthTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
}

export interface ProductVersions {
  ProductCode: string;
  LatestVersion: string;
  SupportedVersions: string[];
}

export interface OrgUnitTypeInfo {
  Id: number;
  Code: string;
  Name: string;
}

export interface MyOrgUnitInfo {
  OrgUnit: {
    Id: number;
    Type: OrgUnitTypeInfo;
    Name: string;
    Code: string | null;
    HomeUrl: string | null;
  };
  Access: {
    IsActive: boolean;
    StartDate: string | null;
    EndDate: string | null;
    CanAccess: boolean;
  };
  PinDate: string | null;
}

export interface PagedResultSet<T> {
  PagingInfo: {
    Bookmark: string;
    HasMoreItems: boolean;
  };
  Items: T[];
}

export interface TocTopic {
  TopicId: number;
  Title: string;
  Url: string;
  SortOrder: number;
  IsHidden: boolean;
  IsLocked: boolean;
  IsBroken: boolean;
  ActivityType: number;
  LastModifiedDate: string | null;
}

export interface TocModule {
  ModuleId: number;
  Title: string;
  SortOrder: number;
  IsHidden: boolean;
  IsLocked: boolean;
  Modules: TocModule[];
  Topics: TocTopic[];
}

export interface TableOfContents {
  Modules: TocModule[];
}

export interface Course {
  id: number;
  code: string;
  name: string;
}

export interface FileTopic {
  course: Course;
  topicId: number;
  title: string;
  url: string;
  modulePath: string[];
  remoteModified: string | null;
}

export interface ManifestEntry {
  courseId: number;
  topicId: number;
  title: string;
  remoteModified: string | null;
  localPath: string;
  sha256: string;
  size: number;
  etag: string | null;
  downloadedAt: string;
}

export interface Manifest {
  version: 1;
  updatedAt: string;
  files: Record<string, ManifestEntry>;
}

export interface SyncOptions {
  assumeYes: boolean;
  dryRun: boolean;
  force: boolean;
  courseFilters: string[];
}
