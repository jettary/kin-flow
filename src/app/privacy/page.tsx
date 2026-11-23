import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'Privacy Policy · KinFlow',
  description: 'What personal data KinFlow collects, why, who receives it and how to delete it.',
};

const contact = 'jettary+kinflow@gmail.com';

export default function PrivacyPage() {
  return (
    <main id="main-content" className="terms-page">
      <div className="terms-shell">
        <Link href="/" className="terms-back">
          ← Back to KinFlow
        </Link>
        <article className="terms-card">
          <p className="terms-eyebrow">KINFLOW</p>
          <h1>Privacy Policy</h1>
          <p className="terms-intro">
            Effective 23 November 2026. This policy explains what personal data KinFlow processes,
            why, who receives it, how long it is kept and how you can control it. See also the{' '}
            <Link href="/terms">Terms of Use</Link>.
          </p>

          <section>
            <h2>1. Who is responsible</h2>
            <p>
              KinFlow is operated by Valentin Zlydnev, an individual developer, who is the data
              controller for the personal data described here. Contact:{' '}
              <a href={`mailto:${contact}`}>{contact}</a>.
            </p>
          </section>

          <section>
            <h2>2. Data we process</h2>
            <p>
              <strong>Google account.</strong> When you sign in with Google we receive your Google
              account identifier, name and profile picture address. Google also confirms that your
              email address is verified; KinFlow does not store your email address.
            </p>
            <p>
              <strong>Financial records you enter.</strong> Families, memberships and roles;
              accounts, balances, categories, income sources, budgets and tags; transactions with
              amounts, currencies, dates, comments and exchange-rate data; and a history of changes
              (audit records) used for corrections, deletions and synchronization conflicts.
            </p>
            <p>
              <strong>Settings.</strong> Display name, appearance and date format, your chosen scope
              per family, notification preferences and whether you have read the AI notice.
            </p>
            <p>
              <strong>Sign-in and security.</strong> A session cookie and, for connected assistants,
              OAuth tokens. Only one-way hashes of session and token values are stored on our
              servers.
            </p>
            <p>
              <strong>Notifications.</strong> If you enable notifications on a device, the push
              subscription address and keys issued by your browser, and short-lived records of
              whether KinFlow is open on that device, so it does not notify you while you are
              looking at it.
            </p>
            <p>
              <strong>Technical data.</strong> Our hosting provider receives your IP address,
              browser details and request times when you use KinFlow. KinFlow does not use
              analytics, advertising or tracking tools.
            </p>
          </section>

          <section>
            <h2>3. Why we use it</h2>
            <p>
              We use this data to provide KinFlow: to sign you in, keep your records, calculate
              balances, budgets and reports, synchronize your devices, show shared records to your
              family, and keep the service secure. The legal basis is performance of our agreement
              with you and our legitimate interest in operating a secure service. Optional AI
              assistance, notifications and connected assistants are based on your choice to turn
              them on; you can stop using them at any time.
            </p>
          </section>

          <section>
            <h2>4. What your family can see</h2>
            <p>
              Members of a family see your name and role, shared records and who created them.
              Personal accounts, categories, budgets and transactions are visible only to you. When
              money moves between a shared and a personal account, or shared income is paid into a
              personal account, other members see only that it occurred, not the amount or details;
              the shared account’s balance still changes for everyone.
            </p>
          </section>

          <section>
            <h2>5. Who receives data</h2>
            <p>
              <strong>Service providers.</strong> Vercel hosts the application and Neon hosts its
              database. Google provides sign-in. These providers process data on our behalf.
            </p>
            <p>
              <strong>Google Gemini, only if you use AI assistance.</strong> The text or audio you
              submit and the names, visibility and currencies of your eligible accounts, categories
              and income sources are sent to Google. It is processed under Google’s unpaid Gemini
              API terms, under which Google may use it to improve its products and people may review
              it. Transaction history is not sent. KinFlow does not store your submitted text or
              audio. See{' '}
              <a href="https://ai.google.dev/gemini-api/terms" rel="noopener noreferrer">
                Google’s Gemini API terms
              </a>
              .
            </p>
            <p>
              <strong>Push services, only if you enable notifications.</strong> Notifications are
              delivered through your browser’s push service, such as Apple, Google or Mozilla. They
              contain generic text and no amounts, categories or account names.
            </p>
            <p>
              <strong>AI assistants you connect.</strong> If you connect an assistant such as Claude
              or ChatGPT, the data it reads is sent to that assistant’s provider and handled under
              that provider’s terms.
            </p>
            <p>
              Exchange rates are downloaded from Frankfurter without any personal data. The optional
              Ko-fi link opens Ko-fi’s own website; KinFlow does not receive payment or supporter
              data. We do not sell your personal data or use it for advertising.
            </p>
          </section>

          <section>
            <h2>6. International transfers</h2>
            <p>
              Our providers may process data outside your country, including in the United States.
              Where data leaves the European Economic Area or the United Kingdom, we rely on the
              providers’ safeguards for such transfers, such as the European Commission’s standard
              contractual clauses.
            </p>
          </section>

          <section>
            <h2>7. How long we keep it</h2>
            <p>
              Your account and records are kept until you delete them. Leaving a family permanently
              deletes your personal records in that family; shared records you created stay with the
              family and show their author as “Former member”. Deleting your KinFlow account in
              Settings removes you from every family and permanently deletes your personal data.
              Sign-in sessions last up to 30 days. Assistant access lasts until you disconnect it or
              90 days pass without use. Undelivered notifications expire after 24 hours.
            </p>
            <p>
              Copies of deleted data may remain in our database provider’s backups until they
              expire. To make sure a restore cannot bring deleted data back, we keep a one-way hash
              of the deleted user and family identifiers.
            </p>
          </section>

          <section>
            <h2>8. Data on your device</h2>
            <p>
              KinFlow uses an essential session cookie and a short-lived sign-in cookie. To work
              offline, it stores your family’s data and unsent changes in your browser, along with
              your selected family and scope. Signing out deletes the offline financial data. No
              advertising or analytics cookies are used.
            </p>
          </section>

          <section>
            <h2>9. Your rights</h2>
            <p>
              You can view and correct your records and display name in KinFlow, and delete your
              account at any time. Depending on where you live, you may also have the right to
              request access to or a copy of your data, its correction or deletion, to restrict or
              object to its processing, and to withdraw consent. To make a request, email{' '}
              <a href={`mailto:${contact}`}>{contact}</a>. You may also complain to your local data
              protection authority.
            </p>
          </section>

          <section>
            <h2>10. Children</h2>
            <p>KinFlow is not intended for children under 16.</p>
          </section>

          <section>
            <h2>11. Changes</h2>
            <p>
              We will update this page if our data practices change and revise the effective date
              above.
            </p>
          </section>
        </article>
      </div>
    </main>
  );
}
