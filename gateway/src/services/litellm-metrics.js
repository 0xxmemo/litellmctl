/**
 * LiteLLM Metrics Service
 * Fetches real-time metrics from LiteLLM proxy API
 * 
 * API Endpoints:
 * - GET /global/spend - Total spend across all keys
 * - GET /model/info - Model information and health
 * - GET /user/info?user_id={id} - User-specific spend
 * - GET /key/info?key={key} - API key spend
 * - GET /global/spend/report?start_date=&end_date= - Date range reports
 * 
 * Docs: https://docs.litellm.ai/docs/proxy/cost_tracking
 */

const LITELLM_PROXY_URL = process.env.LITELLM_URL || process.env.LITELLM_PROXY_URL || 'http://localhost:4040';
const LITELLM_MASTER_KEY = process.env.LITELLM_MASTER_KEY || '';

/**
 * Fetch global spend from LiteLLM
 * @returns {Promise<{spend: number, max_budget: number}>}
 */
export async function getGlobalSpend() {
  try {
    const res = await fetch(`${LITELLM_PROXY_URL}/global/spend`, {
      headers: { 'Authorization': `Bearer ${LITELLM_MASTER_KEY}` }
    });
    
    if (!res.ok) {
      console.error('[LiteLLM] Global spend error:', res.status);
      return { spend: 0, max_budget: 0 };
    }
    
    const data = await res.json();
    return {
      spend: data.spend || 0,
      max_budget: data.max_budget || 0
    };
  } catch (error) {
    console.error('[LiteLLM] Error fetching global spend:', error.message);
    return { spend: 0, max_budget: 0 };
  }
}

/**
 * Fetch model info from LiteLLM
 * @returns {Promise<Array<{model_name: string, model_info: object, health: object}>>}
 */
export async function getModelInfo() {
  try {
    const res = await fetch(`${LITELLM_PROXY_URL}/model/info`, {
      headers: { 'Authorization': `Bearer ${LITELLM_MASTER_KEY}` }
    });
    
    if (!res.ok) {
      console.error('[LiteLLM] Model info error:', res.status);
      return [];
    }
    
    const data = await res.json();
    return data.data || [];
  } catch (error) {
    console.error('[LiteLLM] Error fetching model info:', error.message);
    return [];
  }
}

/**
 * Get user spend by user_id
 * @param {string} userId - User ID or email
 * @returns {Promise<{spend: number, keys: Array}>}
 */
export async function getUserSpend(userId) {
  try {
    const res = await fetch(`${LITELLM_PROXY_URL}/user/info?user_id=${encodeURIComponent(userId)}`, {
      headers: { 'Authorization': `Bearer ${LITELLM_MASTER_KEY}` }
    });
    
    if (!res.ok) {
      return { spend: 0, keys: [] };
    }
    
    const data = await res.json();
    return {
      spend: data.user_info?.spend || 0,
      keys: data.keys || []
    };
  } catch (error) {
    console.error('[LiteLLM] Error fetching user spend:', error.message);
    return { spend: 0, keys: [] };
  }
}

/**
 * Get spend report for date range
 * @param {string} startDate - YYYY-MM-DD
 * @param {string} endDate - YYYY-MM-DD
 * @returns {Promise<{results: Array}>}
 */
export async function getSpendReport(startDate, endDate) {
  try {
    const res = await fetch(
      `${LITELLM_PROXY_URL}/global/spend/report?start_date=${startDate}&end_date=${endDate}`,
      {
        headers: { 'Authorization': `Bearer ${LITELLM_MASTER_KEY}` }
      }
    );
    
    if (!res.ok) {
      return { results: [] };
    }
    
    const data = await res.json();
    return { results: data.results || [] };
  } catch (error) {
    console.error('[LiteLLM] Error fetching spend report:', error.message);
    return { results: [] };
  }
}

/**
 * Get daily activity for a user
 * @param {string} userId - User ID or email
 * @param {string} startDate - YYYY-MM-DD
 * @param {string} endDate - YYYY-MM-DD
 * @returns {Promise<{results: Array}>}
 */
export async function getUserDailyActivity(userId, startDate, endDate) {
  try {
    const res = await fetch(
      `${LITELLM_PROXY_URL}/user/daily/activity?user_id=${encodeURIComponent(userId)}&start_date=${startDate}&end_date=${endDate}`,
      {
        headers: { 'Authorization': `Bearer ${LITELLM_MASTER_KEY}` }
      }
    );
    
    if (!res.ok) {
      return { results: [] };
    }
    
    const data = await res.json();
    return { results: data.results || [] };
  } catch (error) {
    console.error('[LiteLLM] Error fetching user daily activity:', error.message);
    return { results: [] };
  }
}

/**
 * Calculate model usage breakdown
 * @param {Array} models - Array of model info from getModelInfo()
 * @returns {Array<{model: string, requests: number, tokens: number, percentage: string}>}
 */
export function calculateModelUsage(models) {
  if (!models || models.length === 0) return [];
  
  // LiteLLM doesn't track requests per model in /model/info by default
  // We need to use spend logs or track via metadata
  // For now, return model list with zero counts
  return models.map(m => ({
    model: m.model_name,
    requests: 0,
    tokens: 0,
    percentage: '0'
  }));
}

/**
 * Get health status for all models
 * @param {Array} models - Array of model info
 * @returns {Object<{healthy: number, unhealthy: number, total: number}>}
 */
export function getModelHealth(models) {
  if (!models || models.length === 0) {
    return { healthy: 0, unhealthy: 0, total: 0 };
  }
  
  let healthy = 0;
  let unhealthy = 0;
  
  models.forEach(m => {
    if (m.health && m.health.good) {
      healthy++;
    } else {
      unhealthy++;
    }
  });
  
  return {
    healthy,
    unhealthy,
    total: models.length
  };
}

export default {
  getGlobalSpend,
  getModelInfo,
  getUserSpend,
  getSpendReport,
  getUserDailyActivity,
  calculateModelUsage,
  getModelHealth
};
