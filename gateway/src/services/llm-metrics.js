// Backend API Service
// Connects to the backend API to fetch real metrics

const API_BASE = '/api';

/**
 * Get overall dashboard stats
 * @returns {Promise<{totalRequests: number, tokensUsed: number, estimatedCost: number, activeKeys: number}>}
 */
export async function getMetrics() {
  try {
    const res = await fetch(`${API_BASE}/dashboard/stats`, {
      credentials: 'include'
    });
    if (!res.ok) {
      throw new Error(`API error: ${res.status}`);
    }
    return await res.json();
  } catch (error) {
    console.error('Error fetching dashboard stats:', error);
    throw error;
  }
}

/**
 * Get analytics data
 * @returns {Promise<{requests: Array, models: Array, endpoints: Array}>}
 */
export async function getAnalytics(range = '7d') {
  try {
    const res = await fetch(`${API_BASE}/dashboard/analytics?range=${range}`, {
      credentials: 'include'
    });
    if (!res.ok) {
      throw new Error(`API error: ${res.status}`);
    }
    return await res.json();
  } catch (error) {
    console.error('Error fetching analytics:', error);
    throw error;
  }
}

/**
 * Get API keys
 * @returns {Promise<Array>}
 */
export async function getAPIKeys() {
  try {
    const res = await fetch(`${API_BASE}/keys`, {
      credentials: 'include'
    });
    if (!res.ok) {
      throw new Error(`API error: ${res.status}`);
    }
    const data = await res.json();
    // API returns { keys: [...] } — extract the array
    return Array.isArray(data) ? data : (data.keys || []);
  } catch (error) {
    console.error('Error fetching API keys:', error);
    throw error;
  }
}

/**
 * Get global stats (admin only)
 * @returns {Promise<{totalRequests: number, totalUsers: number, totalSpend: number, activeKeys: number, modelUsage: Array, topUsers: Array}>}
 */
export async function getGlobalStats() {
  try {
    const res = await fetch(`${API_BASE}/dashboard/global-stats`, {
      credentials: 'include'
    });
    if (!res.ok) {
      throw new Error(`API error: ${res.status}`);
    }
    return await res.json();
  } catch (error) {
    console.error('Error fetching global stats:', error);
    throw error;
  }
}

/**
 * Get user stats
 * @returns {Promise<{requests: number, tokens: number, spend: number, keys: number, modelUsage: Array, requestHistory: Array}>}
 */
export async function getUserStats() {
  try {
    const res = await fetch(`${API_BASE}/dashboard/user-stats`, {
      credentials: 'include'
    });
    if (!res.ok) {
      throw new Error(`API error: ${res.status}`);
    }
    return await res.json();
  } catch (error) {
    console.error('Error fetching user stats:', error);
    throw error;
  }
}

/**
 * Get model usage data (pie chart)
 * @returns {Promise<Array<{name: string, value: number, percentage: string}>>}
 */
export async function getModelUsage() {
  try {
    const res = await fetch(`${API_BASE}/dashboard/model-usage`, {
      credentials: 'include'
    });
    if (!res.ok) {
      throw new Error(`API error: ${res.status}`);
    }
    return await res.json();
  } catch (error) {
    console.error('Error fetching model usage:', error);
    throw error;
  }
}
