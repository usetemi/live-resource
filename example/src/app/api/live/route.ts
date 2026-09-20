import { live } from "@/live";

export const GET = (request: Request) => live.handle(request);
