import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'Terms of Use · KinFlow',
  description: 'How to use KinFlow and understand its financial records.',
};

export default function TermsPage() {
  return (
    <main id="main-content" className="terms-page">
      <div className="terms-shell">
        <Link href="/" className="terms-back">
          ← Back to KinFlow
        </Link>
        <article className="terms-card">
          <p className="terms-eyebrow">KINFLOW</p>
          <h1>Terms of Use</h1>
          <p className="terms-intro">
            KinFlow is a tool for keeping personal and family financial records. The following terms
            explain what those records represent and how they should be used.
          </p>

          <section>
            <h2>1. Nature of the service</h2>
            <p>
              KinFlow records information entered or confirmed by its users. KinFlow does not
              independently verify that a purchase, transfer, deposit, refund, or other financial
              event occurred, was authorized, or was settled. A saved entry records what a user
              chose to save; it is not a bank statement, payment confirmation, or other official
              record of a financial institution.
            </p>
          </section>

          <section>
            <h2>2. Accuracy of records and calculations</h2>
            <p>
              Balances, histories, budgets, reports, currency conversions, and other figures shown
              in KinFlow depend on the entries, settings, and exchange-rate information available to
              the service. They may be incomplete, delayed, or inaccurate, including where an entry
              has not yet synchronized between devices. Suggested values, where offered, require the
              user’s review before they are saved.
            </p>
          </section>

          <section>
            <h2>3. Your responsibility</h2>
            <p>
              You are responsible for reviewing the information you save and for checking any
              material balance or transaction against the relevant bank, card issuer, payment
              provider, or other authoritative source. Do not rely on KinFlow as the sole basis for
              payments, disputes, tax filings, accounting records, or other consequential decisions.
            </p>
          </section>

          <section>
            <h2>4. No professional advice</h2>
            <p>
              KinFlow provides record-keeping and organizational features. It does not provide
              financial, investment, accounting, tax, or legal advice.
            </p>
          </section>

          <section>
            <h2>5. Optional AI assistance</h2>
            <p>
              If you use optional AI assistance, the text or audio you choose to submit, together
              with limited account and category context, is sent to Google Gemini for processing.
              Under Google’s unpaid API terms, submitted content and responses may be used to
              improve Google products and may be reviewed by people. Do not submit sensitive,
              confidential, or identifying information. Review every suggested entry before saving
              it. KinFlow’s deletion of its copy of an input does not control Google’s handling of
              that input. See{' '}
              <a href="https://ai.google.dev/gemini-api/terms" rel="noopener noreferrer">
                Google’s Gemini API terms
              </a>
              .
            </p>
          </section>

          <section>
            <h2>6. Availability and liability</h2>
            <p>
              KinFlow may be changed, interrupted, or unavailable. To the extent permitted by
              applicable law, the service is provided without a guarantee that its records or
              calculations will be complete, accurate, or available at all times. Nothing in these
              terms excludes or limits any right or liability that cannot lawfully be excluded or
              limited.
            </p>
          </section>
        </article>
      </div>
    </main>
  );
}
