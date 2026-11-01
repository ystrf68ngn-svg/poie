import { handleChat } from "@/lib/model-api";
export const POST = (request: Request) => handleChat(request);
