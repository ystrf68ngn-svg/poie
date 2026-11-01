import { handleApiUsage } from "@/lib/usage";
export async function POST(request: Request) { return handleApiUsage(request); }
