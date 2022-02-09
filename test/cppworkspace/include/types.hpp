#include <variant>

template <typename T, typename Err>
struct ResultPtr {
    constexpr ResultPtr() : m_result{Err{}}, status(Status::Err) {}
    ~ResultPtr() {}
    bool has_value() const {
        return std::holds_alternative<T*>(m_result);
    }

    bool has_err() const {
        return std::holds_alternative<Err>(m_result);
    }
private:
    std::variant<T*, Err> m_result;
    enum Status {
        Ok,
        Err
    } status;
};

template <typename T, typename Err>
struct Result {
    constexpr Result() : m_result{Err{}}, status(Status::Err) {}
    ~Result() {}
    bool has_value() const {
        return this->status == Status::Ok;
    }

    bool has_err() const {
        return this->status == Status::Err;
    }
private:
    std::variant<T, Err> m_result;
    enum Status {
        Ok,
        Err
    } status;
};