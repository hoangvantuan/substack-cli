import type { Env } from '../env/types.js';
import { requestWithRetry } from '../http/request.js';

/**
 * Thrown when the API answers 401 or 403: the cookie is invalid or expired.
 * Authoring commands catch it and exit with EXIT_AUTH (3) rather than the
 * general failure code.
 */
export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthError';
  }
}

/** GET /api/v1/drafts answers 400 for any limit above this (observed: 49 passes, 50 fails). */
export const DRAFTS_MAX_LIMIT = 49;
/** The post_management lists answer 400 for any limit above this (observed: 50 passes, 51 fails). */
export const POST_MANAGEMENT_MAX_LIMIT = 50;

/** A section of the publication, as /api/v1/publication/sections returns it. */
export interface SectionSummary {
  id: number;
  name: string;
  slug: string;
}

/**
 * A draft as the draft endpoints return it. Only the fields this tool reads
 * are typed; the rest stays in `raw`.
 *
 * `draft_section_id` is the field the API actually populates when a section
 * is assigned. The `section_id`/`section_name` fields on the same responses
 * always read null for drafts and must never be used to verify an
 * assignment; `draft_section_name` on the post_management lists is the other
 * populated field.
 */
export interface Draft {
  id: number;
  slug: string | null;
  draft_section_id: number | null;
}

/** One post of the publication regardless of state, as `post list` shows it. */
export interface AuthoringPost {
  id: number;
  slug: string | null;
  title: string | null;
  subtitle: string | null;
  post_date: string | null;
  audience: string | null;
  /** True once the post is public; false for drafts and scheduled posts. */
  is_published: boolean;
  /** Section name when the listing endpoint actually reports one, else null. */
  section: string | null;
  draft_updated_at: string | null;
}

export type PostState = 'draft' | 'scheduled' | 'published';

/** A post's live and staged fields, as `post revise` compares them. */
export interface RevisionRecord {
  published: boolean;
  scheduled: boolean;
  slug: string | null;
  title: string | null;
  draft_title: string | null;
  subtitle: string | null;
  draft_subtitle: string | null;
  /** The live body, a stringified ProseMirror document. */
  body: string | null;
  draft_body: string | null;
  section_id: number | null;
  draft_section_id: number | null;
  cover_image: string | null;
}

/**
 * The authoring API client: one profile's cookie against one publication.
 * Every request carries the cookie, goes through the shared retry logic, and
 * is authenticated-checked here so commands never see a raw 401.
 */
export class SubstackClient {
  constructor(
    private readonly env: Env,
    private readonly base: string,
    private readonly cookie: string,
    private readonly retry = true,
  ) {}

  /** The user id the draft bylines must name; the API rejects a null id. */
  async ownerUserId(): Promise<number> {
    const users = asArray(await this.request('GET', '/api/v1/publication/users'), '/api/v1/publication/users');
    const raw =
      users.find((entry) => entry['role'] === 'admin' && entry['is_byline_only'] !== true) ?? users[0];
    if (raw === undefined || typeof raw['id'] !== 'number') {
      throw new Error('the publication lists no users to name in the draft bylines');
    }
    return raw['id'];
  }

  async listSections(): Promise<SectionSummary[]> {
    const sections = asArray(await this.request('GET', '/api/v1/publication/sections'), '/api/v1/publication/sections');
    return sections.map((section) => ({
      id: typeof section['id'] === 'number' ? section['id'] : -1,
      name: typeof section['name'] === 'string' ? section['name'] : '',
      slug: typeof section['slug'] === 'string' ? section['slug'] : '',
    }));
  }

  async createSection(name: string, description: string): Promise<SectionSummary> {
    const response = asRecord(
      await this.request('POST', '/api/v1/publication/sections', { name, description }),
      'POST /api/v1/publication/sections',
    );
    const section = response['section'];
    if (typeof section !== 'object' || section === null || typeof (section as Record<string, unknown>)['id'] !== 'number') {
      throw new Error('the section was created but the response names no section id');
    }
    const record = section as Record<string, unknown>;
    return {
      id: record['id'] as number,
      name: typeof record['name'] === 'string' ? record['name'] : name,
      slug: typeof record['slug'] === 'string' ? record['slug'] : '',
    };
  }

  async deleteSection(id: number): Promise<void> {
    await this.request('DELETE', `/api/v1/publication/sections/${id}`);
  }

  async createDraft(input: {
    title: string;
    subtitle: string;
    /** The converted document, already serialised to a JSON string. */
    body: string;
    bylineUserId: number;
    audience: string;
    coverImage?: string;
  }): Promise<Draft> {
    const body: Record<string, unknown> = {
      draft_title: input.title,
      draft_subtitle: input.subtitle,
      draft_body: input.body,
      draft_bylines: [{ id: input.bylineUserId, is_guest: false }],
      type: 'newsletter',
      audience: input.audience,
    };
    if (input.coverImage !== undefined) {
      body['cover_image'] = input.coverImage;
    }
    return asDraft(await this.request('POST', '/api/v1/drafts', body), 'POST /api/v1/drafts');
  }

  async getDraft(id: number): Promise<Draft> {
    return asDraft(await this.request('GET', `/api/v1/drafts/${id}`), `GET /api/v1/drafts/${id}`);
  }

  /**
   * The separate update step the API requires for slug and section. The
   * patch is partial: fields left out keep their stored values.
   */
  async updateDraft(id: number, patch: Record<string, unknown>): Promise<Draft> {
    return asDraft(await this.request('PUT', `/api/v1/drafts/${id}`, patch), `PUT /api/v1/drafts/${id}`);
  }

  async deleteDraft(id: number): Promise<void> {
    await this.request('DELETE', `/api/v1/drafts/${id}`);
  }

  /**
   * One page of a listing, for any of the three states. This endpoint is the
   * only listing that pages: `/api/v1/drafts` ignores `offset` outright and
   * answers the same first page forever, so it is never a listing source.
   * `total` lets the caller stop without an extra request.
   */
  async listPostManagement(
    state: PostState,
    limit: number,
    offset: number,
  ): Promise<{ posts: AuthoringPost[]; total: number }> {
    const segment = state === 'draft' ? 'drafts' : state;
    const path =
      `/api/v1/post_management/${segment}?offset=${offset}&limit=${limit}` +
      '&order_by=draft_updated_at&order_direction=desc';
    const raw = asRecord(await this.request('GET', path), `GET /api/v1/post_management/${segment}`);
    const posts = asArray(raw['posts'], `GET /api/v1/post_management/${segment} posts`);
    return { posts: posts.map(summariseAuthoringPost), total: typeof raw['total'] === 'number' ? raw['total'] : posts.length };
  }

  private async request(method: string, path: string, body?: unknown): Promise<unknown> {
    const response = await requestWithRetry(
      this.env,
      {
        url: `${this.base}${path}`,
        method,
        headers: {
          cookie: `substack.sid=${this.cookie}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      { retry: this.retry },
    );
    if (response.status === 401 || response.status === 403) {
      throw new AuthError(
        `the publication rejected the cookie (HTTP ${response.status}); ` +
          `refresh it with: sub-cli profile login`,
      );
    }
    let parsed: unknown;
    if (response.body === '') {
      parsed = null;
    } else {
      try {
        parsed = JSON.parse(response.body);
      } catch {
        throw new Error(`${method} ${path} answered HTTP ${response.status} with a body that is not JSON`);
      }
    }
    if (response.status >= 200 && response.status < 300) {
      return parsed;
    }
    const detail = errorDetail(parsed);
    // A 404 on a draft path means the identifier names nothing, which is worth
    // saying plainly: the method and path tell the reader nothing they did not
    // just type.
    const draftId = /^\/api\/v1\/drafts\/(\d+)$/.exec(path);
    if (response.status === 404 && draftId !== null) {
      throw new Error(`post not found: ${draftId[1]}${detail === '' ? '' : ` (${detail})`}`);
    }
    throw new Error(`${method} ${path} failed with HTTP ${response.status}${detail === '' ? '' : `: ${detail}`}`);
  }

  /**
   * Reads whether a post is published or scheduled straight from the API,
   * so destructive commands never trust their arguments about state.
   */
  async draftState(id: number): Promise<{ published: boolean; scheduled: boolean }> {
    const { published, scheduled } = await this.revisionRecord(id);
    return { published, scheduled };
  }

  /**
   * The pre-publish check the Substack web app runs before publishing. The
   * endpoint is flaky in practice, so callers must treat any failure here as
   * a warning to log, never as a reason to stop.
   */
  async prepublishCheck(id: number): Promise<{ errors: unknown[]; suggestions: unknown[] }> {
    const raw = asRecord(
      await this.request('GET', `/api/v1/drafts/${id}/prepublish`),
      `GET /api/v1/drafts/${id}/prepublish`,
    );
    return {
      errors: Array.isArray(raw['errors']) ? raw['errors'] : [],
      suggestions: Array.isArray(raw['suggestions']) ? raw['suggestions'] : [],
    };
  }

  /**
   * Takes a draft public. With `sendEmail` false the post appears on the web
   * without any email going out; with true the email goes to the audience.
   * Publishing cannot be undone.
   */
  async publishDraft(id: number, options: { sendEmail: boolean }): Promise<Draft> {
    return asDraft(
      await this.request('POST', `/api/v1/drafts/${id}/publish`, {
        send: options.sendEmail,
        share_automatically: false,
      }),
      `POST /api/v1/drafts/${id}/publish`,
    );
  }

  /** Reads the fields an update must be verified against afterwards. */
  async draftFields(id: number): Promise<{ slug: string | null; draft_section_id: number | null; draft_subtitle: string | null }> {
    const raw = asRecord(await this.request('GET', `/api/v1/drafts/${id}`), `GET /api/v1/drafts/${id}`);
    return {
      slug: typeof raw['slug'] === 'string' && raw['slug'] !== '' ? raw['slug'] : null,
      draft_section_id: typeof raw['draft_section_id'] === 'number' ? raw['draft_section_id'] : null,
      draft_subtitle: typeof raw['draft_subtitle'] === 'string' ? raw['draft_subtitle'] : null,
    };
  }

  /**
   * Reads a post with both copies of its content: the live fields readers
   * see and the staged `draft_*` fields a PUT writes. On a published post
   * they differ until the post is published again (see "Revising a
   * published post" in docs/api-observations.md).
   */
  async revisionRecord(id: number): Promise<RevisionRecord> {
    const raw = asRecord(await this.request('GET', `/api/v1/drafts/${id}`), `GET /api/v1/drafts/${id}`);
    const text = (key: string): string | null => (typeof raw[key] === 'string' ? (raw[key] as string) : null);
    const number = (key: string): number | null => (typeof raw[key] === 'number' ? (raw[key] as number) : null);
    const published = raw['is_published'] === true;
    const dated = typeof raw['post_date'] === 'string' && raw['post_date'] !== '';
    return {
      published,
      scheduled: !published && dated,
      slug: text('slug') === '' ? null : text('slug'),
      title: text('title'),
      draft_title: text('draft_title'),
      subtitle: text('subtitle'),
      draft_subtitle: text('draft_subtitle'),
      body: text('body'),
      draft_body: text('draft_body'),
      section_id: number('section_id'),
      draft_section_id: number('draft_section_id'),
      cover_image: text('cover_image') === '' ? null : text('cover_image'),
    };
  }

  /**
   * The public post object for a slug, carrying `body_html`. Sent with the
   * cookie, so the owner reads the whole body even behind a paywall.
   */
  async publicPost(slug: string): Promise<Record<string, unknown>> {
    return asRecord(await this.request('GET', `/api/v1/posts/${slug}`), `GET /api/v1/posts/${slug}`);
  }

  /**
   * Reads the active release schedule of a post: an empty array when the
   * post has no scheduled release, otherwise the pending trigger time and
   * the audience it will go out to.
   */
  async getScheduledRelease(
    id: number,
  ): Promise<Array<{ triggerAt: string; postAudience: string | null }>> {
    const raw = asArray(
      await this.request('GET', `/api/v1/drafts/${id}/scheduled_release`),
      `GET /api/v1/drafts/${id}/scheduled_release`,
    );
    return raw.map((entry) => ({
      triggerAt: typeof entry['trigger_at'] === 'string' ? entry['trigger_at'] : '',
      postAudience: typeof entry['post_audience'] === 'string' ? entry['post_audience'] : null,
    }));
  }

  /**
   * Sets a future release time through the dedicated release endpoint.
   * This never publishes on its own: the API holds the draft until the
   * trigger time arrives, so a future date stays a future date.
   * Requires the draft to have been saved once with `section_chosen`.
   */
  async scheduleRelease(id: number, triggerAt: string, audience: string): Promise<Draft> {
    return asDraft(
      await this.request('POST', `/api/v1/drafts/${id}/scheduled_release`, {
        trigger_at: triggerAt,
        post_audience: audience,
      }),
      `POST /api/v1/drafts/${id}/scheduled_release`,
    );
  }

  /** Removes the scheduled release; the post returns to being a draft. */
  async unscheduleRelease(id: number): Promise<void> {
    await this.request('DELETE', `/api/v1/drafts/${id}/scheduled_release`);
  }

  /**
   * Uploads one image and returns its hosted URL. Observed against the live
   * API (issue #8): POST /api/v1/image takes a single urlencoded form field
   * "image" whose value is either an http(s) URL to re-host or a data URI
   * carrying the file bytes; it answers with {id, url, contentType, bytes,
   * imageWidth, imageHeight} where url is the permanent hosted location.
   */
  async uploadImage(source: string): Promise<{ id: number; url: string }> {
    const response = await requestWithRetry(
      this.env,
      {
        url: `${this.base}/api/v1/image`,
        method: 'POST',
        headers: {
          cookie: `substack.sid=${this.cookie}`,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: `image=${encodeURIComponent(source)}`,
      },
      { retry: this.retry },
    );
    if (response.status === 401 || response.status === 403) {
      throw new AuthError(
        `the publication rejected the cookie (HTTP ${response.status}); ` +
          `refresh it with: sub-cli profile login`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(response.body);
    } catch {
      throw new Error(`POST /api/v1/image answered HTTP ${response.status} with a body that is not JSON`);
    }
    const record = asRecord(parsed, 'POST /api/v1/image');
    if (!(response.status >= 200 && response.status < 300) || typeof record['url'] !== 'string') {
      const detail = errorDetail(record);
      throw new Error(`POST /api/v1/image failed with HTTP ${response.status}${detail === '' ? '' : `: ${detail}`}`);
    }
    return {
      id: typeof record['id'] === 'number' ? record['id'] : -1,
      url: record['url'],
    };
  }
}

/** Maps a raw post object from either listing endpoint to the summary shape. */
export function summariseAuthoringPost(raw: Record<string, unknown>): AuthoringPost {
  const draftTitle = typeof raw['draft_title'] === 'string' ? raw['draft_title'] : null;
  const title = typeof raw['title'] === 'string' && raw['title'] !== '' ? raw['title'] : draftTitle;
  const sectionName = raw['draft_section_name'] ?? raw['section_name'];
  return {
    id: typeof raw['id'] === 'number' ? raw['id'] : -1,
    slug: typeof raw['slug'] === 'string' && raw['slug'] !== '' ? raw['slug'] : null,
    title,
    subtitle: typeof raw['draft_subtitle'] === 'string' ? raw['draft_subtitle'] : typeof raw['subtitle'] === 'string' ? raw['subtitle'] : null,
    post_date: typeof raw['post_date'] === 'string' ? raw['post_date'] : null,
    audience: typeof raw['audience'] === 'string' ? raw['audience'] : null,
    is_published: raw['is_published'] === true,
    section: typeof sectionName === 'string' && sectionName !== '' ? sectionName : null,
    draft_updated_at: typeof raw['draft_updated_at'] === 'string' ? raw['draft_updated_at'] : null,
  };
}

function asDraft(raw: unknown, label: string): Draft {
  const record = asRecord(raw, label);
  if (typeof record['id'] !== 'number') {
    throw new Error(`${label} answered without a draft id`);
  }
  return {
    id: record['id'],
    slug: typeof record['slug'] === 'string' && record['slug'] !== '' ? record['slug'] : null,
    draft_section_id: typeof record['draft_section_id'] === 'number' ? record['draft_section_id'] : null,
  };
}

function asRecord(raw: unknown, label: string): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`${label} answered with an unexpected body`);
  }
  return raw as Record<string, unknown>;
}

function asArray(raw: unknown, label: string): Record<string, unknown>[] {
  if (!Array.isArray(raw)) {
    throw new Error(`${label} answered with an unexpected body`);
  }
  return raw.filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null && !Array.isArray(entry));
}

/** Renders the express-style {"errors":[{param, msg}]} body the API returns on 400s. */
function errorDetail(parsed: unknown): string {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return '';
  }
  // Substack states its business failures as {"error": "...", "type": "single"}
  // -- "Please choose a section.", "You already have a section with that name",
  // "There is already another post with this slug". Those are the messages a
  // caller can act on, so they are read before the field-validation shape.
  const single = (parsed as Record<string, unknown>)['error'];
  if (typeof single === 'string' && single !== '') {
    return single;
  }
  const errors = (parsed as Record<string, unknown>)['errors'];
  if (!Array.isArray(errors)) {
    return '';
  }
  const parts: string[] = [];
  for (const error of errors) {
    if (typeof error !== 'object' || error === null) {
      continue;
    }
    const record = error as Record<string, unknown>;
    const param = typeof record['param'] === 'string' ? record['param'] : '';
    const msg = typeof record['msg'] === 'string' ? record['msg'] : '';
    parts.push(param === '' ? msg : `${param}: ${msg}`);
  }
  return parts.join('; ');
}
