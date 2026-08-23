/**
 * The environment object every part of the CLI sees. Nothing beneath runCli
 * touches the outside world directly; it goes through these capabilities.
 */

export interface Writer {
  write(text: string): void;
}

export interface HttpRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface HttpResponse {
  status: number;
  /** Header names are normalised to lowercase. */
  headers: Record<string, string>;
  body: string;
}

export interface HttpClient {
  request(request: HttpRequest): Promise<HttpResponse>;
}

export interface WriteFileOptions {
  /** POSIX permission bits applied when the file is created. */
  mode?: number;
}

export interface FileSystem {
  readFile(path: string): Promise<string>;
  writeFile(path: string, contents: string, options?: WriteFileOptions): Promise<void>;
  /** Creates the directory and any missing parents. */
  mkdir(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  /**
   * Reads a whole file and returns it base64-encoded so binary assets such
   * as images survive the read without a UTF-8 round trip corrupting bytes.
   * Optional because only flows that read binary assets (image upload) need
   * it; substituted test environments without it never exercise those.
   */
  readFileBase64?(path: string): Promise<string>;
}

export interface StdinSource {
  /** Reads standard input to completion. */
  read(): Promise<string>;
  /**
   * Reads one secret without echoing what is typed. Falls back to plain
   * reading when standard input is not a terminal.
   */
  readHidden(): Promise<string>;
}

export interface Env {
  http: HttpClient;
  fs: FileSystem;
  stdin: StdinSource;
  stdout: Writer;
  stderr: Writer;
  /** Returns the current time as epoch milliseconds. */
  clock(): number;
  /** Sleeps for the given number of milliseconds. */
  sleep(ms: number): Promise<void>;
  /** Environment variables by name. */
  vars: Record<string, string | undefined>;
  homedir(): string;
}
