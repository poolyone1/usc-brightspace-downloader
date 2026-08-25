import type {
  Course,
  MyOrgUnitInfo,
  PagedResultSet,
  ProductVersions,
  TableOfContents,
} from "./types.js";

export interface ApiVersions {
  lp: string;
  le: string;
}

export class BrightspaceHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function retryDelay(response: Response, attempt: number): number {
  const retryAfter = Number.parseFloat(response.headers.get("retry-after") || "");
  if (Number.isFinite(retryAfter) && retryAfter >= 0) {
    return Math.min(retryAfter * 1000, 60_000);
  }
  return Math.min(1000 * 2 ** attempt, 15_000);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function responseError(response: Response): Promise<BrightspaceHttpError> {
  let detail = "";
  try {
    detail = (await response.text()).trim().slice(0, 500);
  } catch {
    // The status code is still useful when the response body cannot be read.
  }
  return new BrightspaceHttpError(
    response.status,
    `Brightspace request failed (${response.status})${detail ? `: ${detail}` : ""}`,
  );
}

export class BrightspaceClient {
  readonly baseUrl: URL;

  constructor(
    baseUrl: string,
    private readonly tokenProvider: () => Promise<string>,
  ) {
    this.baseUrl = new URL(baseUrl);
    if (this.baseUrl.protocol !== "https:") throw new Error("Brightspace URL must use HTTPS.");
  }

  private async request(
    input: URL,
    options: { allowExternalRedirect?: boolean; authenticated?: boolean } = {},
  ): Promise<Response> {
    let target = new URL(input);
    let authenticated = options.authenticated !== false;

    for (let redirectCount = 0; redirectCount < 6; redirectCount += 1) {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const headers = new Headers({ "user-agent": "usc-bs/0.1", accept: "*/*" });
        if (authenticated) headers.set("authorization", `Bearer ${await this.tokenProvider()}`);
        const response = await fetch(target, { method: "GET", headers, redirect: "manual" });

        if (response.status === 429 || response.status >= 500) {
          if (attempt === 4) throw await responseError(response);
          await delay(retryDelay(response, attempt));
          continue;
        }

        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers.get("location");
          if (!location) throw new Error("Brightspace redirect did not include a location.");
          const redirected = new URL(location, target);
          if (redirected.protocol !== "https:") {
            throw new Error("Refusing a non-HTTPS Brightspace redirect.");
          }
          if (redirected.origin !== this.baseUrl.origin) {
            if (!options.allowExternalRedirect) {
              throw new Error(`Refusing cross-origin API redirect to ${redirected.origin}.`);
            }
            authenticated = false;
          }
          target = redirected;
          break;
        }

        if (!response.ok) throw await responseError(response);
        return response;
      }
    }
    throw new Error("Too many redirects from Brightspace.");
  }

  private apiUrl(pathname: string): URL {
    const url = new URL(pathname, this.baseUrl);
    if (url.origin !== this.baseUrl.origin) throw new Error("Invalid Brightspace API URL.");
    return url;
  }

  async json<T>(pathname: string, authenticated = true): Promise<T> {
    const response = await this.request(this.apiUrl(pathname), { authenticated });
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.toLowerCase().includes("json")) {
      throw new Error(`Expected JSON from ${pathname}, received ${contentType || "unknown content"}.`);
    }
    return (await response.json()) as T;
  }

  async versions(): Promise<ApiVersions> {
    const products = await this.json<ProductVersions[]>("/d2l/api/versions/", false);
    const lookup = new Map(products.map((product) => [product.ProductCode.toLowerCase(), product]));
    const lp = lookup.get("lp")?.LatestVersion;
    const le = lookup.get("le")?.LatestVersion;
    if (!lp || !le) throw new Error("Brightspace did not advertise LP and LE API versions.");
    return { lp, le };
  }

  async courses(lpVersion: string): Promise<Course[]> {
    const courses: Course[] = [];
    let bookmark: string | null = null;

    do {
      const url = this.apiUrl(`/d2l/api/lp/${encodeURIComponent(lpVersion)}/enrollments/myenrollments/`);
      url.searchParams.set("isActive", "true");
      url.searchParams.set("canAccess", "true");
      url.searchParams.append("sortBy", "OrgUnitName");
      if (bookmark) url.searchParams.set("bookmark", bookmark);

      const page = await this.json<PagedResultSet<MyOrgUnitInfo>>(`${url.pathname}${url.search}`);
      for (const item of page.Items) {
        const type = `${item.OrgUnit.Type.Code} ${item.OrgUnit.Type.Name}`.toLowerCase();
        if (!type.includes("course") || !type.includes("offering")) continue;
        if (!item.Access.IsActive || !item.Access.CanAccess) continue;
        courses.push({
          id: item.OrgUnit.Id,
          code: item.OrgUnit.Code || String(item.OrgUnit.Id),
          name: item.OrgUnit.Name,
        });
      }
      bookmark = page.PagingInfo.HasMoreItems ? page.PagingInfo.Bookmark : null;
    } while (bookmark);

    return courses;
  }

  async toc(leVersion: string, courseId: number): Promise<TableOfContents> {
    return this.json<TableOfContents>(
      `/d2l/api/le/${encodeURIComponent(leVersion)}/${courseId}/content/toc`,
    );
  }

  async file(leVersion: string, courseId: number, topicId: number): Promise<Response> {
    return this.request(
      this.apiUrl(
        `/d2l/api/le/${encodeURIComponent(leVersion)}/${courseId}/content/topics/${topicId}/file`,
      ),
      { allowExternalRedirect: true },
    );
  }
}
