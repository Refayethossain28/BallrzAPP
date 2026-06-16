import SwiftUI

struct LoginView: View {
    @EnvironmentObject var store: AppStore
    @State private var email = ""
    @State private var password = ""

    var body: some View {
        ZStack {
            Brand.bgDeep.ignoresSafeArea()
            VStack(alignment: .leading, spacing: 0) {
                Spacer()
                Text("ApexVIP")
                    .font(Brand.serif(46, weight: .light))
                    .foregroundStyle(Brand.gold)
                    .tracking(1.5)
                Text("Your chauffeur awaits")
                    .font(.system(size: 15))
                    .foregroundStyle(Brand.fg3)
                    .padding(.top, 6)

                VStack(spacing: 14) {
                    field("Email", text: $email, keyboard: .emailAddress)
                    field("Password", text: $password, secure: true)
                }
                .padding(.top, 40)

                Button("Sign In") {
                    store.signIn(email: email)
                }
                .buttonStyle(GoldButtonStyle())
                .padding(.top, 24)

                Button("Continue as guest") {
                    store.signIn(email: "")
                }
                .buttonStyle(GlassButtonStyle())
                .padding(.top, 12)

                Spacer()
            }
            .padding(.horizontal, 28)
        }
    }

    @ViewBuilder
    private func field(_ placeholder: String, text: Binding<String>,
                       secure: Bool = false, keyboard: UIKeyboardType = .default) -> some View {
        Group {
            if secure {
                SecureField("", text: text, prompt: Text(placeholder).foregroundColor(Brand.fg4))
            } else {
                TextField("", text: text, prompt: Text(placeholder).foregroundColor(Brand.fg4))
                    .keyboardType(keyboard)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
            }
        }
        .foregroundStyle(Brand.fg)
        .padding(.horizontal, 16).padding(.vertical, 15)
        .background(Brand.surface)
        .overlay(RoundedRectangle(cornerRadius: 14).stroke(Brand.border, lineWidth: 1))
        .clipShape(RoundedRectangle(cornerRadius: 14))
    }
}

#Preview { LoginView().environmentObject(AppStore()) }
