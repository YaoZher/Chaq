import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ConversationMessages } from "./conversation-messages";

export function useConversationMessages(onRealtimeMessage: (conversationId: string) => void) {
  const [messageResource] = useState(() => new ConversationMessages());
  const messages = useSyncExternalStore(messageResource.subscribe, messageResource.getSnapshot);
  const onMessage = useRef(onRealtimeMessage);
  onMessage.current = onRealtimeMessage;

  useEffect(() => {
    const listener = (event: Event) => {
      const selection = messageResource.current;
      if (selection && messageResource.receiveRealtime((event as CustomEvent<unknown>).detail)) {
        onMessage.current(selection.resourceId);
      }
    };
    window.addEventListener("chaq:realtime", listener);
    return () => {
      window.removeEventListener("chaq:realtime", listener);
      messageResource.select(null);
    };
  }, [messageResource]);

  return { messages, messageResource };
}
