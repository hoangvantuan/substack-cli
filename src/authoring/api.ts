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

  /** One page of the draft listing. `hasMore` can over-report; treat an empty page as the end. */
  async listDrafts(limit: number, offset: number): Promise<{ posts: AuthoringPost[]; hasMore: boolean }> {
    const raw = asRecord(
      await this.request('GET', `/api/v1/drafts?limit=${limit}&offset=${offset}`),
      'GET /api/v1/drafts',
    );
    const posts = asArray(raw['posts'], 'GET /api/v1/drafts posts');
    return { posts: posts.map(summariseAuthoringPost), hasMore: raw['hasMore'] === true };
  }

  /** One page of the scheduled or published listing (total lets the caller stop without a extra request). */
  async listPostManagement(
    state: 'scheduled' | 'published',
    limit: number,
    offset: number,
  ): Promise<{ posts: AuthoringPost[]; total: number }> {
    const path =
      `/api/v1/post_management/${state}?offset=${offset}&limit=${limit}` +
      '&order_by=draft_updated_at&order_direction=desc';
    const raw = asRecord(await this.request('GET', path), `GET /api/v1/post_management/${state}`);
    const posts = asArray(raw['posts'], `GET /api/v1/post_management/${state} posts`);
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
          `refresh it with: substackctl profile login`,
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
    throw new Error(`${method} ${path} failed with HTTP ${response.status}${detail === '' ? '' : `: ${detail}`}`);
  }

  /**
   * Reads whether a post is published or scheduled straight from the API,
   * so destructive commands never trust their arguments about state.
   */
  async draftState(id: number): Promise<{ published: boolean; scheduled: boolean }> {
    const raw = asRecord(await this.request('GET', `/api/v1/drafts/${id}`), `GET /api/v1/drafts/${id}`);
    const published = raw['is_published'] === true;
    const dated = typeof raw['post_date'] === 'string' && raw['post_date'] !== '';
    return { published, scheduled: !published && dated };
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
