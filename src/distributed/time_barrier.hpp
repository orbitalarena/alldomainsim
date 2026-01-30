#ifndef SIM_TIME_BARRIER_HPP
#define SIM_TIME_BARRIER_HPP

#include <mutex>
#include <condition_variable>
#include <vector>

namespace sim { namespace distributed {

/**
 * @brief Thread-safe synchronization barrier for coordinating worker completion
 *
 * The coordinator calls wait_for_all() to block until every worker has reported
 * completion for the current time step. Workers report via worker_done().
 * After the barrier releases, call reset() before the next step.
 */
class TimeBarrier {
public:
    explicit TimeBarrier(int num_workers);

    /// Block until all workers have reported done (returns false on timeout)
    bool wait_for_all(int timeout_ms = 5000);

    /// Called by coordinator when a worker reports done for the current step
    void worker_done(int worker_id, bool success);

    /// Reset the barrier for the next time step
    void reset();

    int num_workers() const { return num_workers_; }

    /// Returns true only if all workers completed successfully
    bool all_succeeded() const;

private:
    int num_workers_;
    std::mutex mutex_;
    std::condition_variable cv_;
    std::vector<bool> completed_;
    std::vector<bool> success_;
    int done_count_ = 0;
};

}} // namespace sim::distributed

#endif // SIM_TIME_BARRIER_HPP
