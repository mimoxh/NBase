import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { attachmentPreviewKind } from '@nbase/contracts';
import type { AuthRepository } from '../auth/repository.js';
import { clearSessionCookie, publicOriginConfig } from '../auth/session.js';
import { authorizeWorkspace, WorkspaceRouteError } from '../auth/workspace.js';
import { AttachmentError, isAttachmentId, maxAttachmentBytes, PgAttachmentRepository } from './repository.js';

interface WorkspaceParams { workspaceId: string }
interface AttachmentParams extends WorkspaceParams { attachmentId: string }

function headers(reply: FastifyReply): void {
  reply.header('Cache-Control', 'private, no-store');
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('Cross-Origin-Resource-Policy', 'same-origin');
  reply.header('Vary', 'Cookie');
}

function failure(request: FastifyRequest, reply: FastifyReply, error: unknown, secure: boolean) {
  headers(reply);
  if (error instanceof WorkspaceRouteError) {
    if (error.clearCookie) reply.header('Set-Cookie', clearSessionCookie(secure));
    return reply.code(error.statusCode).send({ error: error.code });
  }
  if (error instanceof AttachmentError) return reply.code(error.statusCode).send({ error: error.code });
  request.log.error({ err: error }, 'Attachment request unavailable');
  return reply.code(503).send({ error: 'SERVICE_UNAVAILABLE' });
}

/** One `bytes=a-b`, `a-` or `-n` range; anything else is served whole, as RFC 9110 allows. */
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | 'invalid' | null {
  const match = header ? /^bytes=(\d*)-(\d*)$/.exec(header.trim()) : null;
  if (!match || (!match[1] && !match[2])) return null;
  let start: number, end: number;
  if (!match[1]) { start = Math.max(0, size - Number(match[2])); end = size - 1; }
  else { start = Number(match[1]); end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1; }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) return 'invalid';
  return { start, end };
}

function contentDisposition(name: string, inline: boolean): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\;]/g, '_');
  return `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

export function registerAttachmentRoutes(app: FastifyInstance, attachments: PgAttachmentRepository,
  auth: AuthRepository, publicOrigin: string): void {
  const { origin, secure } = publicOriginConfig(publicOrigin);
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: maxAttachmentBytes },
    (_request, body, done) => done(null, body));

  const uploadActors = new WeakMap<FastifyRequest, string>();
  app.put<{ Params: AttachmentParams; Querystring: { name?: string } }>(
    '/api/workspaces/:workspaceId/attachments/:attachmentId', {
      bodyLimit: maxAttachmentBytes,
      onRequest: async (request, reply) => {
        headers(reply);
        try {
          const actor = await authorizeWorkspace(request, auth, origin, secure,
            request.params.workspaceId, true, 'application/octet-stream');
          uploadActors.set(request, actor);
        } catch (error) { return failure(request, reply, error, secure); }
      },
      errorHandler: (error, request, reply) => {
        if (error.statusCode === 413) return reply.code(413).send({ error: 'ATTACHMENT_TOO_LARGE' });
        return failure(request, reply, error, secure);
      },
    }, async (request, reply) => {
      headers(reply);
      try {
        if (!isAttachmentId(request.params.attachmentId)) throw new AttachmentError(404, 'NOT_FOUND');
        const actor = uploadActors.get(request);
        if (!actor) throw new WorkspaceRouteError(401, 'AUTH_REQUIRED');
        if (!Buffer.isBuffer(request.body) || typeof request.query.name !== 'string') {
          throw new AttachmentError(400, 'INVALID_REQUEST');
        }
        const result = await attachments.save(request.params.workspaceId, actor,
          request.params.attachmentId, request.query.name, request.body);
        return reply.code(result.created ? 201 : 200).send(result.attachment);
      } catch (error) { return failure(request, reply, error, secure); }
    });

  app.get<{ Params: AttachmentParams }>('/api/workspaces/:workspaceId/attachments/:attachmentId', async (request, reply) => {
    headers(reply);
    try {
      await authorizeWorkspace(request, auth, origin, secure, request.params.workspaceId, false);
      const attachment = await attachments.get(request.params.workspaceId, request.params.attachmentId);
      return attachment ? reply.send(attachment) : reply.code(404).send({ error: 'NOT_FOUND' });
    } catch (error) { return failure(request, reply, error, secure); }
  });

  app.get<{ Params: AttachmentParams; Querystring: { download?: string } }>(
    '/api/workspaces/:workspaceId/attachments/:attachmentId/content', async (request, reply) => {
      headers(reply);
      try {
        await authorizeWorkspace(request, auth, origin, secure, request.params.workspaceId, false);
        const attachment = await attachments.get(request.params.workspaceId, request.params.attachmentId);
        if (!attachment) return reply.code(404).send({ error: 'NOT_FOUND' });
        const inline = attachmentPreviewKind(attachment.mediaType) !== null && request.query.download !== '1';
        reply.header('Content-Type', inline ? attachment.mediaType : 'application/octet-stream');
        reply.header('Content-Disposition', contentDisposition(attachment.fileName, inline));
        // Only this page may frame a PDF preview; previews never run scripts of their own.
        reply.header('X-Frame-Options', 'SAMEORIGIN');
        reply.header('Accept-Ranges', 'bytes');
        const range = parseRange(request.headers.range, attachment.byteSize);
        if (range === 'invalid') {
          reply.header('Content-Range', `bytes */${attachment.byteSize}`);
          return reply.code(416).send({ error: 'RANGE_NOT_SATISFIABLE' });
        }
        if (range) {
          const stream = await attachments.range(request.params.workspaceId, attachment, range.start, range.end);
          reply.header('Content-Range', `bytes ${range.start}-${range.end}/${attachment.byteSize}`);
          reply.header('Content-Length', range.end - range.start + 1);
          return reply.code(206).send(stream);
        }
        const bytes = await attachments.bytes(request.params.workspaceId, attachment);
        reply.header('Content-Length', bytes.length);
        return reply.send(bytes);
      } catch (error) { return failure(request, reply, error, secure); }
    });
}
