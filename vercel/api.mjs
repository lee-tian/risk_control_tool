import { handleApiRequest } from '../api/server.mjs';

export default async function handler(req, res) {
  return handleApiRequest(req, res);
}
