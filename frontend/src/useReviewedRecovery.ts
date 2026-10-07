import { useEffect, useState } from 'react';
import { hasUnresolvedSubmission, hydrateReviewedMutation } from './reviewedSettlement';
export default function useReviewedRecovery(scope: string) {
  const [state, setState] = useState({ scope: '', ready: false, error: '' });
  useEffect(() => {
    let active = true;
    setState({ scope, ready: false, error: '' });
    hydrateReviewedMutation(scope).then(() => {
      if (active) setState({ scope, ready: true, error: '' });
    }).catch(() => {
      if (active) setState({ scope, ready: false, error: 'Payment recovery could not be read. Check pending work before starting another payment.' });
    });
    return () => { active = false; };
  }, [scope]);
  return { ready: state.scope === scope && state.ready, error: state.scope === scope ? state.error : '',
    pending: hasUnresolvedSubmission(scope) };
}
