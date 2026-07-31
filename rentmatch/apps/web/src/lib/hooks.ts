import { useEffect, useState } from 'react';
import { watchUserDeals, watchDeal, watchMessages, type Deal, type Message } from './db';

export function useUserDeals(uid: string | undefined) {
  const [deals, setDeals] = useState<Deal[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    if (!uid) return;
    setLoading(true);
    const unsub = watchUserDeals(uid, (d) => { setDeals(d); setLoading(false); });
    return unsub;
  }, [uid]);
  return { deals, loading };
}

export function useDeal(dealId: string | undefined) {
  const [deal, setDeal] = useState<Deal | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    if (!dealId) return;
    setLoading(true);
    const unsub = watchDeal(dealId, (d) => { setDeal(d); setLoading(false); });
    return unsub;
  }, [dealId]);
  return { deal, loading };
}

export function useMessages(dealId: string | undefined) {
  const [messages, setMessages] = useState<Message[]>([]);
  useEffect(() => {
    if (!dealId) return;
    return watchMessages(dealId, setMessages);
  }, [dealId]);
  return messages;
}
