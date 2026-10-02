import { live } from "@/live";

export const POST = (request: Request) => live.handle(request);
// A tab still running the 0.1 client opens with GET; the 400 it gets stops its retries.
export const GET = POST;
