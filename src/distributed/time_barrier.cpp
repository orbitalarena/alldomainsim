#include "distributed/time_barrier.hpp"

#include <chrono>
#include <stdexcept>

namespace sim { namespace distributed {

TimeBarrier::TimeBarrier(int num_workers)
    : num_workers_(num_workers),
      completed_(static_cast<size_t>(num_workers), false),
      success_(static_cast<size_t>(num_workers), false),
      done_count_(0)
{
    if (num_workers <= 0) {
        throw std::invalid_argument("TimeBarrier requires at least 1 worker");
    }
}

bool TimeBarrier::wait_for_all(int timeout_ms) {
    std::unique_lock<std::mutex> lock(mutex_);

    auto deadline = std::chrono::steady_clock::now() +
                    std::chrono::milliseconds(timeout_ms);

    while (done_count_ < num_workers_) {
        if (cv_.wait_until(lock, deadline) == std::cv_status::timeout) {
            // Timed out before all workers finished
            return false;
        }
    }
    return true;
}

void TimeBarrier::worker_done(int worker_id, bool success) {
    std::lock_guard<std::mutex> lock(mutex_);

    if (worker_id < 0 || worker_id >= num_workers_) {
        return; // Invalid worker ID -- silently ignore
    }

    if (!completed_[static_cast<size_t>(worker_id)]) {
        completed_[static_cast<size_t>(worker_id)] = true;
        success_[static_cast<size_t>(worker_id)] = success;
        ++done_count_;

        if (done_count_ >= num_workers_) {
            cv_.notify_all();
        }
    }
}

void TimeBarrier::reset() {
    std::lock_guard<std::mutex> lock(mutex_);
    std::fill(completed_.begin(), completed_.end(), false);
    std::fill(success_.begin(), success_.end(), false);
    done_count_ = 0;
}

bool TimeBarrier::all_succeeded() const {
    // Note: caller should ensure no concurrent modification (call after wait_for_all)
    for (size_t i = 0; i < success_.size(); ++i) {
        if (!success_[i]) return false;
    }
    return true;
}

}} // namespace sim::distributed
