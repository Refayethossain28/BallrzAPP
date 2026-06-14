import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, CreditCard, Plus, Check, Trash2, Smartphone } from 'lucide-react';
import { MOCK_PAYMENT_CARDS } from '../data/mockData';
import type { PaymentCard } from '../types';

export default function PaymentMethods() {
  const navigate = useNavigate();
  const [cards, setCards] = useState<PaymentCard[]>(MOCK_PAYMENT_CARDS);
  const [showAddForm, setShowAddForm] = useState(false);
  const [newCard, setNewCard] = useState({ number: '', expiry: '', cvv: '', name: '' });
  const [addFocus, setAddFocus] = useState<string | null>(null);

  const setDefault = (id: string) => {
    setCards(prev => prev.map(c => ({ ...c, isDefault: c.id === id })));
  };

  const remove = (id: string) => {
    setCards(prev => prev.filter(c => c.id !== id));
  };

  const handleAddCard = (e: React.FormEvent) => {
    e.preventDefault();
    const last4 = newCard.number.replace(/\s/g, '').slice(-4);
    const type = newCard.number.startsWith('4') ? 'visa' : 'mastercard';
    const nc: PaymentCard = {
      id: `card-${Date.now()}`,
      type,
      last4,
      expiry: newCard.expiry,
      name: newCard.name,
      isDefault: cards.length === 0,
    };
    setCards(prev => [...prev, nc]);
    setShowAddForm(false);
    setNewCard({ number: '', expiry: '', cvv: '', name: '' });
  };

  const formatCardNumber = (value: string) => {
    const digits = value.replace(/\D/g, '').slice(0, 16);
    return digits.replace(/(.{4})/g, '$1 ').trim();
  };

  const formatExpiry = (value: string) => {
    const digits = value.replace(/\D/g, '').slice(0, 4);
    if (digits.length >= 2) return `${digits.slice(0, 2)}/${digits.slice(2)}`;
    return digits;
  };

  const iStyle = (f: string): React.CSSProperties => ({
    width: '100%',
    background: '#1a1a1a',
    border: `1px solid ${addFocus === f ? 'rgba(201,168,76,0.6)' : 'rgba(255,255,255,0.1)'}`,
    borderRadius: 10,
    padding: '12px 14px',
    color: '#ffffff',
    fontSize: 14,
    outline: 'none',
    fontFamily: 'inherit',
    boxSizing: 'border-box' as const,
    transition: 'border-color 0.2s',
  });

  const cardBrand = (type: string) => type === 'visa' ? 'Visa' : type === 'mastercard' ? 'Mastercard' : 'Amex';

  return (
    <div style={{ minHeight: '100vh', background: '#0a0a0a', maxWidth: 480, margin: '0 auto' }}>
      {/* Header */}
      <div style={{
        padding: '52px 20px 20px',
        background: '#111111',
        borderBottom: '1px solid rgba(255,255,255,0.07)',
      }}>
        <button
          onClick={() => navigate('/profile')}
          style={{
            background: 'none', border: 'none', cursor: 'pointer',
            display: 'flex', alignItems: 'center', gap: 8,
            color: '#888888', marginBottom: 14, padding: 0,
          }}
        >
          <ArrowLeft size={18} />
          <span style={{ fontSize: 13 }}>Back</span>
        </button>
        <div style={{ fontSize: 22, fontWeight: 700, color: '#ffffff', marginBottom: 4 }}>
          Payment Methods
        </div>
        <div style={{ fontSize: 13, color: '#888888' }}>
          Manage your saved payment cards
        </div>
      </div>

      <div style={{ padding: '20px', paddingBottom: 40, display: 'flex', flexDirection: 'column', gap: 12 }}>
        {/* Cards list */}
        {cards.map(card => (
          <div
            key={card.id}
            style={{
              background: '#111111',
              border: `1.5px solid ${card.isDefault ? 'rgba(201,168,76,0.4)' : 'rgba(255,255,255,0.08)'}`,
              borderRadius: 16,
              padding: '18px',
              position: 'relative',
              overflow: 'hidden',
            }}
          >
            {/* Card gradient bg */}
            <div style={{
              position: 'absolute', top: 0, right: 0, width: 140, height: '100%',
              background: 'radial-gradient(ellipse at right, rgba(201,168,76,0.06) 0%, transparent 70%)',
              pointerEvents: 'none',
            }} />

            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14 }}>
              <div style={{
                width: 44, height: 32, borderRadius: 6,
                background: card.type === 'visa'
                  ? 'linear-gradient(135deg, #1a1f71 0%, #2b3ab7 100%)'
                  : 'linear-gradient(135deg, #eb001b 30%, #ff5f00 70%)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                flexShrink: 0,
              }}>
                <span style={{ fontSize: 9, fontWeight: 900, color: '#ffffff', letterSpacing: '0.06em' }}>
                  {cardBrand(card.type).toUpperCase()}
                </span>
              </div>

              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 14, fontWeight: 600, color: '#ffffff', marginBottom: 3 }}>
                  {cardBrand(card.type)} •••• {card.last4}
                </div>
                <div style={{ fontSize: 12, color: '#888888' }}>
                  {card.name} · Expires {card.expiry}
                </div>
              </div>

              {card.isDefault && (
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 4,
                  padding: '3px 10px', borderRadius: 20,
                  background: 'rgba(201,168,76,0.1)',
                  border: '1px solid rgba(201,168,76,0.2)',
                }}>
                  <Check size={10} color="#C9A84C" />
                  <span style={{ fontSize: 10, color: '#C9A84C', fontWeight: 600 }}>DEFAULT</span>
                </div>
              )}
            </div>

            <div style={{
              display: 'flex', gap: 10, marginTop: 14,
              paddingTop: 14, borderTop: '1px solid rgba(255,255,255,0.06)',
            }}>
              {!card.isDefault && (
                <button
                  onClick={() => setDefault(card.id)}
                  style={{
                    flex: 1, padding: '9px',
                    background: 'transparent',
                    border: '1px solid rgba(255,255,255,0.1)',
                    borderRadius: 8, color: '#888888',
                    fontSize: 12, cursor: 'pointer',
                  }}
                >
                  Set as default
                </button>
              )}
              <button
                onClick={() => remove(card.id)}
                style={{
                  padding: '9px 14px',
                  background: 'rgba(239,68,68,0.06)',
                  border: '1px solid rgba(239,68,68,0.15)',
                  borderRadius: 8, color: '#ef4444',
                  fontSize: 12, cursor: 'pointer',
                  display: 'flex', alignItems: 'center', gap: 5,
                }}
              >
                <Trash2 size={13} />
                Remove
              </button>
            </div>
          </div>
        ))}

        {/* Digital wallets */}
        <div style={{
          background: '#111111',
          border: '1px solid rgba(255,255,255,0.08)',
          borderRadius: 16,
          overflow: 'hidden',
        }}>
          {[
            { label: 'Apple Pay', sub: 'Pay with Touch ID or Face ID' },
            { label: 'Google Pay', sub: 'Pay with your Google account' },
          ].map((w, i) => (
            <button
              key={w.label}
              style={{
                width: '100%',
                display: 'flex', alignItems: 'center', gap: 14,
                padding: '14px 18px',
                background: 'none', border: 'none',
                borderBottom: i === 0 ? '1px solid rgba(255,255,255,0.06)' : 'none',
                cursor: 'pointer',
                textAlign: 'left',
              }}
            >
              <div style={{
                width: 38, height: 38, borderRadius: 10,
                background: 'rgba(255,255,255,0.05)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                <Smartphone size={18} color="#888888" />
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13, color: '#ffffff', fontWeight: 500 }}>{w.label}</div>
                <div style={{ fontSize: 11, color: '#555555' }}>{w.sub}</div>
              </div>
              <span style={{ fontSize: 11, color: '#555555', letterSpacing: '0.04em' }}>SETUP</span>
            </button>
          ))}
        </div>

        {/* Add card */}
        {!showAddForm ? (
          <button
            onClick={() => setShowAddForm(true)}
            style={{
              width: '100%',
              padding: '16px',
              background: 'transparent',
              border: '1px dashed rgba(201,168,76,0.3)',
              borderRadius: 14,
              color: '#C9A84C',
              fontSize: 14,
              fontWeight: 600,
              cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
              transition: 'all 0.2s',
            }}
          >
            <Plus size={18} />
            Add New Card
          </button>
        ) : (
          <form
            onSubmit={handleAddCard}
            style={{
              background: '#111111',
              border: '1px solid rgba(201,168,76,0.3)',
              borderRadius: 16,
              padding: '18px',
              display: 'flex',
              flexDirection: 'column',
              gap: 12,
            }}
          >
            <div style={{ fontSize: 14, fontWeight: 600, color: '#ffffff', marginBottom: 4 }}>
              Add New Card
            </div>

            <div>
              <div style={{ fontSize: 11, color: '#888888', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Card Number</div>
              <input
                placeholder="0000 0000 0000 0000"
                value={newCard.number}
                onChange={e => setNewCard(n => ({ ...n, number: formatCardNumber(e.target.value) }))}
                onFocus={() => setAddFocus('num')}
                onBlur={() => setAddFocus(null)}
                style={iStyle('num')}
                inputMode="numeric"
              />
            </div>

            <div style={{ display: 'flex', gap: 12 }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 11, color: '#888888', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Expiry</div>
                <input
                  placeholder="MM/YY"
                  value={newCard.expiry}
                  onChange={e => setNewCard(n => ({ ...n, expiry: formatExpiry(e.target.value) }))}
                  onFocus={() => setAddFocus('exp')}
                  onBlur={() => setAddFocus(null)}
                  style={iStyle('exp')}
                  inputMode="numeric"
                />
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 11, color: '#888888', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.06em' }}>CVV</div>
                <input
                  placeholder="000"
                  value={newCard.cvv}
                  onChange={e => setNewCard(n => ({ ...n, cvv: e.target.value.replace(/\D/g, '').slice(0, 4) }))}
                  onFocus={() => setAddFocus('cvv')}
                  onBlur={() => setAddFocus(null)}
                  style={iStyle('cvv')}
                  inputMode="numeric"
                  type="password"
                />
              </div>
            </div>

            <div>
              <div style={{ fontSize: 11, color: '#888888', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Name on Card</div>
              <input
                placeholder="Full name"
                value={newCard.name}
                onChange={e => setNewCard(n => ({ ...n, name: e.target.value }))}
                onFocus={() => setAddFocus('name')}
                onBlur={() => setAddFocus(null)}
                style={iStyle('name')}
              />
            </div>

            <div style={{ display: 'flex', gap: 10, marginTop: 4 }}>
              <button
                type="submit"
                style={{
                  flex: 1, padding: '13px',
                  background: '#C9A84C', border: 'none',
                  borderRadius: 10, color: '#0a0a0a',
                  fontSize: 14, fontWeight: 700, cursor: 'pointer',
                }}
              >
                Save Card
              </button>
              <button
                type="button"
                onClick={() => setShowAddForm(false)}
                style={{
                  flex: 1, padding: '13px',
                  background: 'rgba(255,255,255,0.06)',
                  border: '1px solid rgba(255,255,255,0.1)',
                  borderRadius: 10, color: '#888888',
                  fontSize: 14, cursor: 'pointer',
                }}
              >
                Cancel
              </button>
            </div>
          </form>
        )}

        {/* Security note */}
        <div style={{
          display: 'flex', gap: 10, alignItems: 'flex-start',
          padding: '12px 14px',
          background: 'rgba(255,255,255,0.02)',
          border: '1px solid rgba(255,255,255,0.06)',
          borderRadius: 10,
          marginTop: 4,
        }}>
          <CreditCard size={14} color="#555555" style={{ flexShrink: 0, marginTop: 1 }} />
          <div style={{ fontSize: 11, color: '#555555', lineHeight: 1.5 }}>
            Card details are encrypted and stored securely. We never store your CVV.
          </div>
        </div>
      </div>
    </div>
  );
}
