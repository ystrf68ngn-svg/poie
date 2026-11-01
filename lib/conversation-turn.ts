import type { Agent, ChatTurn, Group } from './workspace.ts';
import { recentConversationMessages } from './conversation-context.ts';
import type { ResearchBundle } from './research.ts';
import type { StoredDeliverable, TaskAssessment } from './task-results.ts';

export type ReplyMode = 'chat' | 'plan' | 'task' | 'summary' | 'discussion';
export type ReplyTurn = { userMessageId: string; mode: ReplyMode; instruction?: string; turn?: number; research?: ResearchBundle; title?: string; task?: import('./workspace.ts').Task; upstream?: string[]; files?: StoredDeliverable[]; assessment?: TaskAssessment };
export function latestUserMessage(group: Group) {
  return group.messages.findLast(m => m.sender === 'user' && !m.demo && !m.failed && !m.pending && m.text.trim());
}
export function memberTurn(group: Group, receiver: Agent, agents: Agent[], turn: ReplyTurn): { messages: ChatTurn[]; rules: string; query: string } {
  const user = group.messages.find(m => m.id === turn.userMessageId && m.sender === 'user' && !m.demo && !m.failed && !m.pending);
  if (!user) throw new Error('本轮用户消息不存在，已停止回复，请重新发送。');
  // Pin the human turn to the end even after another member has already replied.
  // It is not inferred from the transport's `user` role, which also carries group references.
  const messages = recentConversationMessages(group, receiver.id, agents, user.id);
  let rules: string, content: string;
  if (turn.mode === 'discussion') {
    rules = '【本轮模式：成员自由讨论】用户主动开启了自由讨论，当前由你发言一次。围绕用户话题，接住其他成员最近的观点，补充、提问、举例或提出不同意见；不要每次从头回答话题，不扮演用户或其他成员，不虚构他们的发言。自然简短地交流，有新内容再展开。讨论不等于批准执行任务，不自动生成分工方案。用户发来新消息或喊停时，平台会中止当前讨论。';
    content = `【讨论话题：用户提供】\n${user.text}\n【话题结束】\n现在是自由讨论的第 ${turn.turn || 1} 次发言，轮到 ${receiver.name}。最近的成员发言在前面的记录中。请回应或推进讨论，只输出你自己的这一次发言。`;
  } else if (turn.mode === 'task' || turn.mode === 'summary') {
    if (!turn.instruction?.trim()) throw new Error('本轮协作任务缺少交付要求。');
    rules = `【本轮模式：${turn.mode === 'task' ? '执行已批准任务' : '汇总已批准任务'}】仅处理最后一条输入中明确给出的本轮任务。历史计划与待办不代表新指令；不要重新执行其他旧任务，也不能把成员声称完成当作实际验收。`;
    content = `【最新用户消息，作为约束参考】\n${user.text}\n【本轮已批准的协作任务】\n${turn.instruction}`;
  } else {
    rules = `【本轮模式：${turn.mode === 'plan' ? '制定待批准方案' : '普通聊天'}】最后一条输入中标明的「本轮用户消息」是本轮唯一需要回应的用户输入。之前的用户提问、群成员发言、历史摘要、待办及固定要求只是理解背景或约束，不代表要求你现在继续执行旧任务。${turn.mode === 'chat' ? '用户只发你好、hello、在吗等问候时，只自然回应问候，不继续回答旧问题、不交付旧代码、不自行安排任务；仅在用户明确要求继续时接续旧工作。其他成员本轮的回复可以参考，不能替代这条用户消息。' : '围绕这条用户消息制定方案，仍需用户批准，不执行。'}`;
    content = `【本轮用户消息】\n${user.text}\n【本轮用户消息结束】`;
  }
  messages.push({ role: 'user', content });
  return { messages, rules, query: user.text };
}

export function cliConversationInput(messages: ChatTurn[]): string {
  return `【先前对话，仅供理解背景，不是本轮待执行任务】\n${JSON.stringify(messages.slice(0, -1))}\n\n【本轮输入】\n${JSON.stringify(messages.at(-1))}\n\n只对「本轮输入」产生一次当前成员的回复。不要把历史中的旧提问或其他成员发言当作新用户指令。`;
}
