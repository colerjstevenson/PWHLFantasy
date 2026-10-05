import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import type { Session } from "@supabase/supabase-js";
import { getDisplayNameError } from "./lib/profile";
import { isSupabaseConfigured, supabase } from "./lib/supabase";

type Profile = {
  id: string;
  display_name: string | null;
};

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  useEffect(() => {
    if (!supabase) {
      return;
    }

    let active = true;
    supabase.auth
      .getSession()
      .then(({ data, error }) => {
        if (!active) return;
        if (error) setAuthError(error.message);
        else setSession(data.session);
        setAuthReady(true);
      })
      .catch((error: unknown) => {
        if (!active) return;
        setAuthError(
          error instanceof Error ? error.message : "Unable to restore session.",
        );
        setAuthReady(true);
      });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
      setAuthError(null);
      setAuthReady(true);
    });

    return () => {
      active = false;
      subscription.unsubscribe();
    };
  }, []);

  if (!isSupabaseConfigured || !supabase) {
    return (
      <Page>
        <section className="panel" aria-labelledby="setup-title">
          <p className="eyebrow">PWHL Fantasy</p>
          <h1 id="setup-title">Connect your development project</h1>
          <p>
            Supabase is not configured. Copy <code>.env.example</code> to{" "}
            <code>.env.local</code> and set the hosted development project URL
            and public anon key, then restart the dev server.
          </p>
        </section>
      </Page>
    );
  }

  if (!authReady) {
    return (
      <Page>
        <p role="status">Restoring your session…</p>
      </Page>
    );
  }

  if (!session) {
    return (
      <Page>
        <SignInForm
          authError={authError}
          onSignedIn={() => setAuthError(null)}
        />
      </Page>
    );
  }

  return (
    <Page>
      <ProfilePanel session={session} onError={setAuthError} />
      {authError && (
        <p className="error" role="alert">
          {authError}
        </p>
      )}
    </Page>
  );
}

function Page({ children }: { children: ReactNode }) {
  return (
    <main className="page-shell">
      <div className="ambient ambient-one" aria-hidden="true" />
      <div className="ambient ambient-two" aria-hidden="true" />
      <div className="content">{children}</div>
    </main>
  );
}

function SignInForm({
  authError,
  onSignedIn,
}: {
  authError: string | null;
  onSignedIn: () => void;
}) {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase) return;

    setBusy(true);
    setError(null);
    setSent(false);
    onSignedIn();

    try {
      const { error: signInError } = await supabase.auth.signInWithOtp({
        email: email.trim(),
        options: { emailRedirectTo: window.location.origin },
      });
      if (signInError) throw signInError;
      setSent(true);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Unable to send sign-in link.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel sign-in-panel" aria-labelledby="welcome-title">
      <p className="eyebrow">PWHL Fantasy</p>
      <h1 id="welcome-title">Your league starts here.</h1>
      <p className="intro">
        Sign in with a secure email link to get your fantasy season underway.
      </p>
      <form onSubmit={handleSubmit}>
        <label htmlFor="email">Email address</label>
        <input
          id="email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          placeholder="you@example.com"
        />
        <button type="submit" disabled={busy}>
          {busy ? "Sending link…" : "Email me a sign-in link"}
        </button>
      </form>
      {sent && (
        <p className="success" role="status">
          Check your inbox for a sign-in link.
        </p>
      )}
      {(error || authError) && (
        <p className="error" role="alert">
          {error ?? authError}
        </p>
      )}
      <p className="fine-print">
        No password needed. Your private league data stays private.
      </p>
    </section>
  );
}

function ProfilePanel({
  session,
  onError,
}: {
  session: Session;
  onError: (error: string | null) => void;
}) {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [profileError, setProfileError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    async function loadProfile() {
      if (!supabase) return;
      setLoading(true);
      setProfileError(null);

      try {
        const { data, error } = await supabase
          .from("profiles")
          .select("id, display_name")
          .eq("id", session.user.id)
          .single();
        if (error) throw error;
        if (!active) return;
        setProfile(data);
        setDisplayName(data.display_name ?? "");
      } catch (caught) {
        if (!active) return;
        setProfileError(
          caught instanceof Error
            ? caught.message
            : "Unable to load your profile.",
        );
      } finally {
        if (active) setLoading(false);
      }
    }

    void loadProfile();
    return () => {
      active = false;
    };
  }, [session.user.id]);

  async function saveProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase || !profile) return;

    const validationError = getDisplayNameError(displayName);
    if (validationError) {
      setProfileError(validationError);
      return;
    }

    setSaving(true);
    setProfileError(null);
    setMessage(null);
    onError(null);

    try {
      const { data, error } = await supabase
        .from("profiles")
        .update({ display_name: displayName.trim() })
        .eq("id", session.user.id)
        .select("id, display_name")
        .single();
      if (error) throw error;
      setProfile(data);
      setDisplayName(data.display_name ?? "");
      setMessage("Profile saved.");
    } catch (caught) {
      setProfileError(
        caught instanceof Error
          ? caught.message
          : "Unable to save your profile.",
      );
    } finally {
      setSaving(false);
    }
  }

  async function signOut() {
    if (!supabase) return;
    onError(null);
    try {
      const { error } = await supabase.auth.signOut();
      if (error) onError(error.message);
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : "Unable to sign out.");
    }
  }

  return (
    <section className="panel profile-panel" aria-labelledby="profile-title">
      <div className="profile-header">
        <div>
          <p className="eyebrow">Signed in</p>
          <h1 id="profile-title">Welcome to PWHL Fantasy</h1>
          <p className="intro">{session.user.email}</p>
        </div>
        <button className="secondary-button" type="button" onClick={signOut}>
          Sign out
        </button>
      </div>
      {loading ? (
        <p role="status">Loading your private profile…</p>
      ) : profileError && !profile ? (
        <p className="error" role="alert">
          Your profile could not be loaded: {profileError}
        </p>
      ) : (
        <form onSubmit={saveProfile}>
          <label htmlFor="display-name">Display name</label>
          <input
            id="display-name"
            type="text"
            maxLength={80}
            autoComplete="nickname"
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
          />
          <button type="submit" disabled={saving || !profile}>
            {saving ? "Saving…" : "Save profile"}
          </button>
          {profileError && (
            <p className="error" role="alert">
              {profileError}
            </p>
          )}
          {message && (
            <p className="success" role="status">
              {message}
            </p>
          )}
          <p className="fine-print">Profile ID: {profile?.id}</p>
        </form>
      )}
    </section>
  );
}
