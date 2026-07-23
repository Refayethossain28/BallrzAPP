import SwiftUI
import ConciergeCore

struct ConversationView: View {
    @ObservedObject var store: ConversationStore
    @State private var draft = ""

    var body: some View {
        VStack(spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(spacing: 8) {
                        ForEach(store.items) { row($0) }
                    }
                    .padding(12)
                }
                .onChange(of: store.items.count) { _ in
                    if let last = store.items.last {
                        withAnimation { proxy.scrollTo(last.id, anchor: .bottom) }
                    }
                }
            }
            inputBar
        }
        .navigationTitle("Sushi crew · 3")
        .navigationBarTitleDisplayMode(.inline)
    }

    @ViewBuilder
    private func row(_ item: ConversationStore.Item) -> some View {
        switch item {
        case .message(let message):
            MessageBubble(message: message).id(item.id)
        case .system(_, let text):
            Text(text)
                .font(.caption)
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity)
                .id(item.id)
        case .proposal(let proposal):
            SplitProposalCard(
                proposal: proposal,
                confirmed: store.isConfirmed(proposal),
                onConfirm: { store.confirm(proposal) }
            )
            .id(item.id)
        }
    }

    private var inputBar: some View {
        HStack(spacing: 8) {
            TextField("Message — try \"Dinner was $138.60, split between me, Sam and Alex\"", text: $draft, axis: .vertical)
                .textFieldStyle(.roundedBorder)
                .onSubmit(submit)
            Button(action: submit) {
                Image(systemName: "arrow.up.circle.fill").font(.title2)
            }
            .disabled(draft.trimmingCharacters(in: .whitespaces).isEmpty)
        }
        .padding(10)
        .background(.bar)
    }

    private func submit() {
        store.send(draft)
        draft = ""
    }
}

struct MessageBubble: View {
    let message: Message

    var body: some View {
        HStack {
            if message.isMe { Spacer(minLength: 40) }
            VStack(alignment: .leading, spacing: 2) {
                if !message.isMe {
                    Text(message.sender)
                        .font(.caption2.bold())
                        .foregroundStyle(.tint)
                }
                Text(message.text)
            }
            .padding(.vertical, 8)
            .padding(.horizontal, 11)
            .background(message.isMe ? Color.accentColor.opacity(0.85) : Color(.secondarySystemBackground))
            .foregroundStyle(message.isMe ? .white : .primary)
            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
            if !message.isMe { Spacer(minLength: 40) }
        }
    }
}

/// The agent's proposal card — structured tool output rendered natively and
/// confirmed by a human tap. After execution it locks (the idempotent state).
struct SplitProposalCard: View {
    let proposal: SplitProposal
    let confirmed: Bool
    let onConfirm: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                Circle().fill(.green).frame(width: 8, height: 8)
                Text(confirmed ? "ASSISTANT · split executed" : "ASSISTANT · proposed split")
                    .font(.caption.bold())
                Spacer()
                Text(confirmed ? "done" : "needs confirmation")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
            .padding(12)
            .background(Color(.tertiarySystemBackground))

            VStack(spacing: 0) {
                ForEach(proposal.debtors) { share in
                    HStack {
                        Text("\(share.name) owes you")
                        Spacer()
                        Text("$\(share.dollars, specifier: "%.2f")")
                            .monospacedDigit().bold()
                    }
                    .padding(.vertical, 7)
                    Divider()
                }
                HStack {
                    Text("Bill $\(proposal.totalDollars, specifier: "%.2f") · \(proposal.shares.count)-way even split")
                        .font(.caption).foregroundStyle(.secondary)
                    Spacer()
                }
                .padding(.top, 8)
            }
            .padding(12)

            if !confirmed {
                Button(action: onConfirm) {
                    Text("Confirm & request")
                        .bold().frame(maxWidth: .infinity).padding(.vertical, 10)
                }
                .buttonStyle(.borderedProminent)
                .padding([.horizontal, .bottom], 12)
            }

            Text("idempotency key: \(proposal.idempotencyKey)")
                .font(.caption2.monospaced())
                .foregroundStyle(.secondary)
                .padding([.horizontal, .bottom], 12)
        }
        .background(Color(.secondarySystemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 16).stroke(.quaternary))
    }
}
